import { handleOrder } from "./service.js";

const router = {};
router.get("/:id", handleOrder);

export default router;
