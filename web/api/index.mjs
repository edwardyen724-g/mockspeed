// The web app on Vercel: every path comes here (web/vercel.json) and goes to web/app.mjs.
import { app } from "../app.mjs";

const handle = app(process.env);
export default { fetch: (request) => handle(request) };
