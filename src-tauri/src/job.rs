//! Tracking of an export: progress reported to the front end, and cancellation requested by it.

use crate::error::coded;
use anyhow::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[derive(Clone)]
pub struct Job {
    cancel: Arc<AtomicBool>,
    report: Arc<dyn Fn(f32) + Send + Sync>,
    /// Part of the whole export this job covers: `(start, width)` in 0..=1.
    span: (f32, f32),
}

impl Job {
    pub fn new(cancel: Arc<AtomicBool>, report: impl Fn(f32) + Send + Sync + 'static) -> Self {
        Self {
            cancel,
            report: Arc::new(report),
            span: (0.0, 1.0),
        }
    }

    /// A job nobody watches and nobody cancels.
    #[cfg(test)]
    pub fn detached() -> Self {
        Self::new(Arc::new(AtomicBool::new(false)), |_| {})
    }

    /// Fails with a `cancelled` error once the user asked to stop.
    pub fn check(&self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(coded("cancelled", &[], "Export cancelled"));
        }
        Ok(())
    }

    /// Reports `fraction` (0..=1) of *this job's* share of the export.
    pub fn progress(&self, fraction: f32) {
        let f = fraction.clamp(0.0, 1.0);
        (self.report)(self.span.0 + self.span.1 * f);
    }

    /// The slice `[from, to]` of this job, as a job of its own: a stage reports
    /// 0..=1 without knowing where it sits in the pipeline.
    pub fn slice(&self, from: f32, to: f32) -> Job {
        Job {
            cancel: self.cancel.clone(),
            report: self.report.clone(),
            span: (self.span.0 + self.span.1 * from, self.span.1 * (to - from)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn recording() -> (Job, Arc<AtomicBool>, Arc<Mutex<Vec<f32>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let cancel = Arc::new(AtomicBool::new(false));
        let sink = seen.clone();
        let job = Job::new(cancel.clone(), move |f| sink.lock().unwrap().push(f));
        (job, cancel, seen)
    }

    #[test]
    fn a_running_job_passes_its_checks() {
        assert!(Job::detached().check().is_ok());
    }

    #[test]
    fn cancelling_makes_every_check_fail_with_a_translatable_code() {
        let (job, cancel, _) = recording();
        cancel.store(true, Ordering::Relaxed);
        let e = crate::error::CmdError::from(job.check().unwrap_err());
        assert_eq!(e.code, "cancelled");
    }

    #[test]
    fn progress_is_clamped_to_the_unit_interval() {
        let (job, _, seen) = recording();
        job.progress(-1.0);
        job.progress(0.5);
        job.progress(7.0);
        assert_eq!(*seen.lock().unwrap(), vec![0.0, 0.5, 1.0]);
    }

    #[test]
    fn a_slice_maps_its_own_range_into_the_whole() {
        let (job, _, seen) = recording();
        let stage = job.slice(0.25, 0.75);
        stage.progress(0.0);
        stage.progress(0.5);
        stage.progress(1.0);
        assert_eq!(*seen.lock().unwrap(), vec![0.25, 0.5, 0.75]);
    }

    #[test]
    fn slices_nest() {
        let (job, _, seen) = recording();
        job.slice(0.5, 1.0).slice(0.0, 0.5).progress(1.0);
        assert_eq!(*seen.lock().unwrap(), vec![0.75]);
    }

    #[test]
    fn a_slice_shares_the_cancel_flag() {
        let (job, cancel, _) = recording();
        let stage = job.slice(0.0, 0.5);
        cancel.store(true, Ordering::Relaxed);
        assert!(stage.check().is_err());
    }
}
