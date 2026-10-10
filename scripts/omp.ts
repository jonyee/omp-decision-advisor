import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedOmpEnvironment } from "./settings.ts";

try {
  // The extension reads the active profile's settings; /decision can configure
  // an unconfigured first launch without guessing Azure resources or identities.
  const environment = installedOmpEnvironment();
  const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  // Development launches must not also discover an installed copy of this extension.
  const child = spawn("omp", ["--no-extensions", "--extension", extension, ...process.argv.slice(2)], { env: environment, stdio: "inherit", shell: false });
  child.on("error", () => { console.error("Could not launch omp. Install OMP 18.8.7 or compatible."); process.exitCode = 1; });
  child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
} catch {
  console.error("Could not launch installed OMP. Install OMP 18.8.7 or compatible, then use /decision to configure scoring in your selected profile.");
  process.exitCode = 1;
}
