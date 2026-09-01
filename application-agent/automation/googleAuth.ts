import { loadEnv } from "vite";
import {
  authorizeGoogleSheets,
  googleOAuthClientFile,
  googleOAuthTokenFile,
  type GoogleAuthEnvironment,
} from "./googleOAuth";

function loadLocalEnvironment(): GoogleAuthEnvironment {
  const loaded = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return process.env;
}
const environment = loadLocalEnvironment();
if (environment.ATELIER_GOOGLE_AUTH_MODE && environment.ATELIER_GOOGLE_AUTH_MODE !== "oauth") {
  throw new Error("npm run career-agent:google-auth requires ATELIER_GOOGLE_AUTH_MODE=oauth.");
}

try {
  const result = await authorizeGoogleSheets({
    clientFile: googleOAuthClientFile(environment),
    tokenFile: googleOAuthTokenFile(environment),
  });
  console.log(`[career-agent-google-auth] stored server-side credentials at ${result.tokenFile}`);
  console.log(`[career-agent-google-auth] callback used ${result.callbackUri}`);
  console.log("[career-agent-google-auth] only the Node tracker host can read these credentials; the Vite client receives no token material.");
} catch (error) {
  console.error(`[career-agent-google-auth] ${error instanceof Error ? error.message : "authorization failed"}`);
  process.exitCode = 1;
}
