// One queue carries two kinds of job. Control jobs (start / stop / restart) are named 'control'; everything else
// is a deployment, including jobs queued before names meant anything.
export const jobProcessor = ({ deploy, control }) => (job) => (job.name === 'control' ? control(job) : deploy(job));
