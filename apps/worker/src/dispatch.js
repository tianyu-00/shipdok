// One queue carries two kinds of job. Control jobs (start / stop / restart) are named 'control'; everything else
// is a deployment, including jobs queued before names meant anything.
// While a job runs, its app is marked busy so the monitor leaves that app alone (a swap stops containers on purpose).
export const jobProcessor = ({ deploy, control, activity }) => (job) => {
  const work = () => (job.name === 'control' ? control(job) : deploy(job));
  const appId = job.data?.appId;
  return activity && appId ? activity.run(appId, work) : work();
};
