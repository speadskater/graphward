import { handleRequest } from "./service.js";

const router = {};
router.get("/:id", handleRequest);

export default router;
