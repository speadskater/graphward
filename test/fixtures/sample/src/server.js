import userRouter from "./user-routes.js";

const app = {};
const requireAuth = () => {};
app.use("/users", requireAuth, userRouter);
