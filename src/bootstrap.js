// Keep service-worker activation ahead of the app import so every module and
// page asset is read from one matching offline release.
// Activate the matching offline bundle before importing any application modules.
// This also upgrades phones still running the pre-authentication service worker.
async function prepareOfflineBundle() {
  if (!("serviceWorker" in navigator) || !navigator.onLine) return;
  const registration = await navigator.serviceWorker.register("./sw.js?release=food-1", { scope: "./", updateViaCache: "none" });
  await registration.update();
  const worker = registration.installing || registration.waiting;
  if (!worker) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("The update is taking too long. Please reload to try again.")), 20000);
    const finish = error => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", check);
      error ? reject(error) : resolve();
    };
    const check = () => {
      if (worker.state === "installed") worker.postMessage({ type: "SKIP_WAITING" });
      if (worker.state === "activated") finish();
      if (worker.state === "redundant") finish(new Error("The update could not be installed. Please reload to try again."));
    };
    worker.addEventListener("statechange", check);
    check();
  });
  // Reload styles and vendor assets as well as the module graph from the new cache.
  location.reload();
  return true;
}

try {
  if (!await prepareOfflineBundle()) await import("./main.js");
} catch {
  const root = document.querySelector("#auth-root");
  const message = document.createElement("p");
  message.textContent = "Pantry Loop could not finish loading. Check your connection and reload. Your saved pantry has not been deleted.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Reload";
  retry.addEventListener("click", () => location.reload());
  root.replaceChildren(message, retry);
}
