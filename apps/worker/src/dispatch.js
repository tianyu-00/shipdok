// One queue carries four kinds of job. Control jobs (start / stop / restart) are named 'control', image clean-up jobs
// 'prune' and 'removeimage', deleting an app 'deleteapp'; everything else is a deployment, including jobs queued before names meant anything.
// While a job runs, its app is marked busy so the monitor leaves that app alone (a swap stops containers on purpose).
const PRUNE_JOBS = new Set(['prune', 'removeimage']);
export const jobProcessor = ({ deploy, control, prune, deleteApp, activity }) => (job) => {
  const work = () => (job.name === 'control' ? control(job) : job.name === 'deleteapp' ? deleteApp(job) : PRUNE_JOBS.has(job.name) ? prune(job) : deploy(job));
  const appId = job.data?.appId;
  return activity && appId ? activity.run(appId, work) : work();
};
