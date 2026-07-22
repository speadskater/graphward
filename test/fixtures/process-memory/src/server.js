import orderRouter from "./order-routes.js";

const app = {};
app.use("/orders", orderRouter);
