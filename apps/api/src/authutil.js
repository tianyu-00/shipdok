import rateLimit from "express-rate-limit";

export const limiter = (max) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { error: "Too many attempts, try again later" },
  });

const regenerate = (req) => new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));
const save = (req) => new Promise((resolve, reject) => req.session.save((e) => (e ? reject(e) : resolve())));

export async function startSession(req, userId) {
  await regenerate(req); // new session ID on privilege change (prevents fixation)
  req.session.userId = userId;
  req.session.createdAt = Date.now();
  await save(req);
}
