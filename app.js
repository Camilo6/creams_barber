const INVENTORY_STORAGE_KEY = "navaja-norte-inventory";

const initialInventory = [
  { id: "p1", name: "Cera mate Urban", category: "Peinado", stock: 2, price: 28000 },
  { id: "p2", name: "Aceite para barba", category: "Barba", stock: 3, price: 32000 },
  { id: "p3", name: "Shampoo revitalizante", category: "Cuidado capilar", stock: 4, price: 24000 },
  { id: "p4", name: "Crema para afeitar", category: "Afeitado", stock: 12, price: 19000 },
  { id: "p5", name: "Polvo texturizador", category: "Peinado", stock: 8, price: 35000 },
  { id: "p6", name: "Bálsamo para barba", category: "Barba", stock: 1, price: 29000 },
  { id: "p7", name: "Tónico capilar", category: "Cuidado capilar", stock: 15, price: 22000 },
];

let appointments = [];
let inventory = getStoredList(INVENTORY_STORAGE_KEY, initialInventory);
let toastTimer;

function getStoredList(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return fallback.map((item) => ({ ...item }));
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : fallback.map((item) => ({ ...item }));
  } catch (error) {
    console.warn(`No se pudo leer ${key} desde el almacenamiento local.`, error);
    return fallback.map((item) => ({ ...item }));
  }
}

function saveInventory() {
  try {
    localStorage.setItem(INVENTORY_STORAGE_KEY, JSON.stringify(inventory));
  } catch (error) {
    console.warn("No se pudo guardar el inventario en este navegador.", error);
    showToast("No se pudieron guardar los cambios en este navegador.");
  }
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatCurrency(amount) {
  return `$${Number(amount).toLocaleString("es-CO")}`;
}

function getInitials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(year, month - 1, day + days, 12);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function appointmentDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(year, month - 1, day, 12).toLocaleDateString("es-CO", { day: "2-digit", month: "short" });
}

function statusClass(status) {
  if (status === "Confirmada") return "status-confirmed";
  if (status === "Pendiente") return "status-pending";
  if (status === "Cancelada") return "status-cancelled";
  return "status-completed";
}

function statusLabel(appointment) {
  if (appointment.status !== "Cancelada") return appointment.status;
  return appointment.cancelledBy === "customer" ? "Cancelada por cliente" : "Cancelada por barbería";
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

async function loadAppointments() {
  const from = todayISO();
  const to = addDays(from, 60);
  try {
    const response = await fetch(`/api/appointments?from=${from}&to=${to}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudieron cargar las citas.");
    appointments = data.appointments;
    renderAppointments();
  } catch (error) {
    console.error("No se pudieron cargar las citas desde el servidor.", error);
    showToast("No se pudo conectar con las reservas. Comprueba que el servidor esté activo.");
  }
}

function renderAppointments() {
  const today = todayISO();
  const todayList = appointments.filter((appointment) => appointment.date === today)
    .sort((a, b) => a.time.localeCompare(b.time));
  const activeToday = todayList.filter((appointment) => appointment.status === "Confirmada");
  const todayBody = document.querySelector("#today-appointments");
  document.querySelector("#today-count").textContent = String(activeToday.length).padStart(2, "0");
  document.querySelector("#nav-appointments-count").textContent = activeToday.length;
  document.querySelector("#stat-appointments").innerHTML = `${String(activeToday.length).padStart(2, "0")} <small>citas</small>`;
  document.querySelector("#stat-confirmed").innerHTML = `${String(activeToday.length).padStart(2, "0")} <small>citas</small>`;
  document.querySelector("#confirmed-progress").style.width = activeToday.length ? "100%" : "0%";
  document.querySelector("#stat-revenue").textContent = formatCurrency(
    activeToday.reduce((total, appointment) => total + appointment.price, 0),
  );
  todayBody.innerHTML = todayList.length ? todayList.slice(0, 5).map((appointment) => `
    <tr>
      <td class="time-cell">${escapeHTML(appointment.time)}</td>
      <td><span class="client-cell"><span class="avatar" style="background:${avatarColor(appointment.name)}">${escapeHTML(getInitials(appointment.name))}</span><strong>${escapeHTML(appointment.name)}</strong></span></td>
      <td>${escapeHTML(appointment.service)}</td><td>${escapeHTML(appointment.barber)}</td>
      <td><span class="status ${statusClass(appointment.status)}">${escapeHTML(statusLabel(appointment))}</span></td>
    </tr>`).join("")
    : '<tr><td class="empty-row" colspan="5">Aún no hay citas para hoy. Comparte el formulario de reservas para recibir la primera.</td></tr>';

  const query = document.querySelector("#appointment-search").value.trim().toLocaleLowerCase("es");
  const filtered = [...appointments].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
    .filter((appointment) => appointment.name.toLocaleLowerCase("es").includes(query));
  document.querySelector("#all-count").textContent = appointments.length;
  document.querySelector("#all-appointments").innerHTML = filtered.length ? filtered.map((appointment) => `
    <tr><td><strong>${escapeHTML(appointmentDate(appointment.date))}</strong> · ${escapeHTML(appointment.time)}</td>
    <td><span class="client-cell"><span class="avatar" style="background:${avatarColor(appointment.name)}">${escapeHTML(getInitials(appointment.name))}</span><strong>${escapeHTML(appointment.name)}</strong></span></td>
    <td>${escapeHTML(appointment.service)}</td><td>${escapeHTML(appointment.barber)}</td>
    <td>${formatCurrency(appointment.price)}</td><td><span class="status ${statusClass(appointment.status)}">${escapeHTML(statusLabel(appointment))}</span></td>
    <td>${appointment.status === "Confirmada" ? `<button class="cancel-appointment-button" data-cancel-id="${escapeHTML(appointment.id)}">Cancelar</button>` : "—"}</td></tr>`).join("")
    : '<tr><td class="empty-row" colspan="7">Todavía no hay reservas en el sistema.</td></tr>';
}

function avatarColor(name) {
  const colors = ["#e9dfd0", "#dce8df", "#e7dfe9", "#e8e2cf", "#dce5e8"];
  return colors[name.length % colors.length];
}

function renderInventory() {
  const lowStock = inventory.filter((product) => product.stock <= 4);
  document.querySelector("#stat-low-stock").innerHTML = `${String(lowStock.length).padStart(2, "0")} <small>productos</small>`;
  document.querySelector("#low-stock-list").innerHTML = lowStock.length ? lowStock.slice(0, 3).map((product, index) => `
    <div class="stock-item"><span class="product-art art-${index % 3}">${["✳", "◒", "▱"][index % 3]}</span>
    <span class="stock-copy"><strong>${escapeHTML(product.name)}</strong><small>${escapeHTML(product.category)}</small></span>
    <span class="stock-quantity">${product.stock} ${product.stock === 1 ? "unidad" : "unidades"}</span></div>`).join("")
    : '<p class="empty-row">Todo el stock está en buen nivel.</p>';

  const query = document.querySelector("#product-search").value.trim().toLocaleLowerCase("es");
  const filtered = inventory.filter((product) => `${product.name} ${product.category}`.toLocaleLowerCase("es").includes(query));
  document.querySelector("#product-count").textContent = inventory.length;
  document.querySelector("#inventory-table").innerHTML = filtered.length ? filtered.map((product) => `
    <tr><td><strong>${escapeHTML(product.name)}</strong></td><td>${escapeHTML(product.category)}</td>
    <td><span class="stock-control"><button data-stock-id="${escapeHTML(product.id)}" data-change="-1" aria-label="Reducir stock de ${escapeHTML(product.name)}">−</button><strong>${product.stock}</strong><button data-stock-id="${escapeHTML(product.id)}" data-change="1" aria-label="Aumentar stock de ${escapeHTML(product.name)}">＋</button></span></td>
    <td>${formatCurrency(product.price)}</td><td><span class="${product.stock <= 4 ? "stock-low" : "stock-ok"}">${product.stock <= 4 ? "Stock bajo" : "Disponible"}</span></td>
    <td><button class="text-link" data-stock-id="${escapeHTML(product.id)}" data-change="1">Reabastecer +1</button></td></tr>`).join("")
    : '<tr><td class="empty-row" colspan="6">No encontramos productos con ese nombre.</td></tr>';

  document.querySelector("#inventory-summary").innerHTML = `
    <article class="summary-card"><span>Productos diferentes</span><strong>${inventory.length}</strong></article>
    <article class="summary-card"><span>Unidades en inventario</span><strong>${inventory.reduce((total, product) => total + Number(product.stock), 0)}</strong></article>
    <article class="summary-card"><span>Necesitan reposición</span><strong>${lowStock.length}</strong></article>`;
}

function switchView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.view === name));
  const current = document.querySelector(`.nav-link[data-view="${name}"]`);
  document.querySelector("#breadcrumb-current").textContent = current ? current.textContent.trim() : "Inicio";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function addMessage(text, sender) {
  const messages = document.querySelector("#chat-messages");
  const message = document.createElement("div");
  message.className = `message message-${sender}`;
  message.textContent = text;
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
}

function assistantReply(message) {
  const text = message.toLocaleLowerCase("es");
  if (text.includes("precio") || text.includes("cuesta") || text.includes("vale")) {
    return "Los precios y el catálogo de servicios están pendientes de confirmar con la barbería.";
  }
  if (text.includes("servicio") || text.includes("ofrecen")) {
    return "El menú real se completará después de confirmar los servicios con el equipo de The Creams Barber & Grooming.";
  }
  if (text.includes("horario") || text.includes("abren") || text.includes("abierto")) {
    return "El horario de atención está pendiente de confirmación con la barbería.";
  }
  if (text.includes("ubicación") || text.includes("direccion") || text.includes("dirección")) {
    return "Estamos en Cl. 33 Sur #7-37, San Cristóbal, Bogotá.";
  }
  if (text.includes("reserv") || text.includes("cita") || text.includes("agendar")) {
    return "Puedes enviar una solicitud desde el formulario de reservas. El equipo debe confirmar la disponibilidad.";
  }
  return "Puedo ayudarte con servicios, precios, ubicación y reservas. Consulta con el equipo para confirmar horarios y disponibilidad.";
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
document.querySelectorAll("[data-view-link]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.viewLink)));
document.querySelector("#appointment-search").addEventListener("input", renderAppointments);
document.querySelector("#all-appointments").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel-id]");
  if (!button) return;
  const appointment = appointments.find((item) => item.id === button.dataset.cancelId);
  if (!appointment || !window.confirm(`¿Cancelar la cita de ${appointment.name} el ${appointmentDate(appointment.date)} a las ${appointment.time}?`)) return;

  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/appointments/${encodeURIComponent(appointment.id)}/cancel`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo cancelar la cita.");
    appointment.status = "Cancelada";
    appointment.cancelledBy = "barber";
    renderAppointments();
    showToast("Cita cancelada. El horario quedó disponible.");
  } catch (error) {
    console.error("No se pudo cancelar la cita desde el panel.", error);
    showToast(error.message || "No se pudo cancelar la cita.");
    button.disabled = false;
  }
});
document.querySelector("#product-search").addEventListener("input", renderInventory);
document.querySelector("#inventory-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-stock-id]");
  if (!button) return;
  const product = inventory.find((item) => item.id === button.dataset.stockId);
  if (!product) return;
  product.stock = Math.max(0, product.stock + Number(button.dataset.change));
  saveInventory();
  renderInventory();
  showToast(`${product.name}: ${product.stock} ${product.stock === 1 ? "unidad disponible" : "unidades disponibles"}.`);
});

document.querySelector("#add-product-button").addEventListener("click", () => document.querySelector("#product-dialog").showModal());
document.querySelector("#product-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  inventory.push({
    id: `p${Date.now()}`, name: String(data.get("name")).trim(), category: String(data.get("category")).trim(),
    stock: Number(data.get("stock")), price: Number(data.get("price")),
  });
  saveInventory();
  renderInventory();
  event.currentTarget.closest("dialog").close();
  event.currentTarget.reset();
  showToast("Producto agregado al inventario.");
});

document.querySelector("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  addMessage(message, "user");
  input.value = "";
  window.setTimeout(() => addMessage(assistantReply(message), "bot"), 350);
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  document.querySelector("#chat-input").value = button.dataset.prompt;
  document.querySelector("#chat-form").requestSubmit();
}));

const displayDate = new Date();
document.querySelector("#today-date").textContent = displayDate.toLocaleDateString("es-CO", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
document.querySelector("#welcome-date").prepend(`${displayDate.toLocaleDateString("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toLocaleUpperCase("es-CO")} `);
renderAppointments();
renderInventory();
loadAppointments();
window.setInterval(loadAppointments, 30_000);
