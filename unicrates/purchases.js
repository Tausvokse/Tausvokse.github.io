const buy = document.querySelector("#buy-pro");
const status = document.querySelector("#checkout-status");
const orderStatus = document.querySelector("#order-status");
const downloads = document.querySelector("#order-downloads");
const storageKey = "unicrates-purchases-v1";
let api,
  selectedOrder,
  generation = 0;

function publicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
function validAccess(value) {
  return (
    value &&
    /^[A-Za-z0-9_-]{22}$/.test(value.orderId || "") &&
    /^[A-Za-z0-9_-]{43}$/.test(value.accessToken || "")
  );
}
function savedOrders() {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.filter(validAccess) : [];
  } catch {
    return [];
  }
}
function remember(intent) {
  if (!validAccess(intent))
    throw new Error("Purchase access could not be prepared.");
  const orders = savedOrders().filter(
    (order) => order.orderId !== intent.orderId,
  );
  selectedOrder = { orderId: intent.orderId, accessToken: intent.accessToken };
  orders.push(selectedOrder);
  sessionStorage.setItem(storageKey, JSON.stringify(orders));
}
function save(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function request(suffix = "") {
  const response = await fetch(
    new URL(`/v1/orders/${selectedOrder.orderId}${suffix}`, api),
    {
      headers: { Authorization: `Bearer ${selectedOrder.accessToken}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    const value = await response.json().catch(() => ({}));
    if (value.error === "purchase_revoked")
      throw new Error(
        "Access was withdrawn after a refund or payment dispute. Contact support if this is unexpected.",
      );
    if (response.status === 401)
      throw new Error(
        "Purchase access is invalid or has expired. Contact support with your Paddle receipt.",
      );
    throw new Error(
      "Downloads are temporarily unavailable. Your purchase access is saved in this tab.",
    );
  }
  return response;
}
function action(label, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button secondary";
  button.textContent = label;
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await callback();
    } catch (error) {
      orderStatus.textContent =
        error.message || "Please try again or contact support.";
    } finally {
      button.disabled = false;
    }
  });
  return button;
}
function purchaseControls() {
  downloads.replaceChildren();
  if (!selectedOrder) return;
  const controls = document.createElement("div");
  controls.className = "purchase-actions";
  controls.append(
    action("Save purchase access", () => {
      save(
        new Blob(
          [
            JSON.stringify(
              { version: 1, apiOrigin: api.origin, ...selectedOrder },
              null,
              2,
            ),
          ],
          { type: "application/json" },
        ),
        `unicrates-purchase-${selectedOrder.orderId}.json`,
      );
    }),
    action("Refresh downloads", () => pollOrder()),
  );
  downloads.append(controls);
  const hint = document.createElement("p");
  hint.className = "small";
  hint.textContent =
    "Save your purchase access file before closing this tab. It opens downloads for 30 days; keep it private. For later downloads, contact support with your receipt.";
  downloads.append(hint);
}
async function showReady(value) {
  if (
    !Array.isArray(value.files) ||
    value.files.length !== 6 ||
    value.files.some(
      (file) =>
        !/^(fabric|neoforge)-(server-only|server|client)$/.test(file.id),
    )
  )
    throw new Error("The release files are not ready. Please contact support.");
  orderStatus.textContent =
    "Payment confirmed. Download your license and choose the files for your server.";
  downloads.append(
    action("Download license.key", async () => {
      const response = await request("/license");
      save(await response.blob(), "license.key");
    }),
  );
  const instructions = document.createElement("p");
  instructions.textContent =
    "Server-only: install one server file and configure its resource pack. Server + client: install the server file on your server and its matching client file on each player’s client.";
  downloads.append(instructions);
  for (const loader of ["fabric", "neoforge"]) {
    const group = document.createElement("div");
    group.className = "download-group";
    const title = document.createElement("h3");
    title.textContent = loader === "fabric" ? "Fabric" : "NeoForge";
    group.append(title);
    for (const file of value.files.filter((file) =>
      file.id.startsWith(loader + "-"),
    )) {
      const label = file.id.endsWith("server-only")
        ? "Server-only JAR"
        : file.id.endsWith("server")
          ? "Server JAR"
          : "Client JAR";
      group.append(
        action(label, async () => {
          const response = await request("/files/" + file.id),
            blob = await response.blob(),
            bytes = await blob.arrayBuffer();
          const hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          if (hash !== file.sha256 || bytes.byteLength !== file.bytes)
            throw new Error(
              "The download could not be verified. Please try again.",
            );
          save(blob, file.name);
        }),
      );
    }
    downloads.append(group);
  }
}
async function pollOrder() {
  if (!selectedOrder || !api) return;
  const current = ++generation;
  purchaseControls();
  for (let attempt = 0; attempt < 24 && current === generation; attempt++) {
    const value = await (await request()).json();
    if (current !== generation) return;
    if (value.status === "ready") {
      await showReady(value);
      return;
    }
    orderStatus.textContent =
      value.status === "processing"
        ? "Payment confirmed. Your license is being prepared. You can check again using saved purchase access."
        : "Waiting for Paddle to confirm payment. Closing the checkout does not confirm a purchase.";
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (current === generation)
    orderStatus.textContent += " Use “Refresh downloads” to check again.";
}
function recoveryControls() {
  const section = document.createElement("div");
  section.className = "purchase-recovery";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.hidden = true;
  input.addEventListener("change", async () => {
    try {
      const file = input.files[0];
      if (!file || file.size > 4096)
        throw new Error("Choose a UniCrates purchase access file.");
      const value = JSON.parse(await file.text());
      if (
        value.version !== 1 ||
        value.apiOrigin !== api.origin ||
        !validAccess(value)
      )
        throw new Error(
          "This purchase access file is not valid for this store.",
        );
      remember(value);
      await pollOrder();
    } catch (error) {
      orderStatus.textContent = error.message;
    }
    input.value = "";
  });
  section.append(
    action("Open saved purchase access", () => input.click()),
    input,
  );
  const orders = savedOrders();
  if (orders.length > 1) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Purchases in this tab");
    for (const order of orders) {
      const option = document.createElement("option");
      option.value = order.orderId;
      option.textContent = "Order " + order.orderId;
      select.append(option);
    }
    select.value = selectedOrder?.orderId || orders.at(-1).orderId;
    select.addEventListener("change", () => {
      selectedOrder = orders.find((order) => order.orderId === select.value);
      pollOrder().catch((error) => {
        orderStatus.textContent = error.message;
      });
    });
    section.append(select);
  }
  downloads.before(section);
}
async function loadPaddle() {
  if (window.Paddle) return window.Paddle;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.paddle.com/paddle/v2/paddle.js";
    script.onload = resolve;
    script.onerror = () =>
      reject(
        new Error(
          "The payment form could not be loaded. Please try again later.",
        ),
      );
    document.head.append(script);
  });
  return window.Paddle;
}
async function initialize() {
  const response = await fetch("store-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Store configuration is unavailable.");
  const config = await response.json(),
    download = publicUrl(config.liteDownloadUrl);
  if (download && download.hostname === "www.curseforge.com") {
    document.querySelector("#lite-download").href = download.href;
    document.querySelector("#lite-download").textContent =
      "Get Lite on CurseForge";
    document.querySelector("#lite-status").textContent =
      "Choose the file for your loader and installation mode.";
  }
  api = publicUrl(config.apiOrigin);
  if (api && api.origin === config.apiOrigin) {
    selectedOrder = savedOrders().at(-1);
    recoveryControls();
    if (selectedOrder)
      pollOrder().catch((error) => {
        orderStatus.textContent = error.message;
      });
  }
  if (
    !config.checkoutEnabled ||
    !api ||
    !/^live_[A-Za-z0-9]+$/.test(config.clientToken || "") ||
    !/^pri_[a-z0-9]{26}$/.test(config.priceId || "")
  )
    return;
  buy.disabled = false;
  buy.textContent = "Buy Pro — US$40 once";
  status.textContent =
    "One server license. No subscription or custom animation service.";
  buy.addEventListener("click", async () => {
    buy.disabled = true;
    status.textContent = "Preparing checkout…";
    try {
      const response = await fetch(new URL("/v1/orders", api), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(
          "Checkout is temporarily unavailable. You have not been charged.",
        );
      remember(await response.json());
      purchaseControls();
      const paddle = await loadPaddle();
      if (!window.unicratesPaddleInitialized) {
        paddle.Initialize({
          token: config.clientToken,
          eventCallback: (event) => {
            if (event.name === "checkout.completed")
              pollOrder().catch((error) => {
                orderStatus.textContent = error.message;
              });
          },
        });
        window.unicratesPaddleInitialized = true;
      }
      paddle.Checkout.open({
        items: [{ priceId: config.priceId, quantity: 1 }],
        customData: { unicrates_order: selectedOrder.orderId },
        settings: {
          theme: "dark",
          successUrl: "https://taushop.me/unicrates/?order=completed#pro",
        },
      });
      status.textContent =
        "Complete payment in the Paddle form. Confirmed payment enables downloads here.";
    } catch (error) {
      status.textContent =
        error.message || "Checkout is unavailable. Please contact support.";
    } finally {
      buy.disabled = false;
    }
  });
}
initialize().catch(() => {
  buy.disabled = true;
  status.textContent =
    "Checkout is temporarily unavailable. Please contact support.";
});
