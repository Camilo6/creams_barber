const form = document.querySelector("#public-booking-form");
const serviceSelect = document.querySelector("#service-select");
const barberSelect = document.querySelector("#barber-select");
const dateInput = document.querySelector("#date-input");
const timeInput = document.querySelector("#time-input");
const slotsGrid = document.querySelector("#slots-grid");
const availabilityMessage = document.querySelector("#availability-message");
const serviceSummary = document.querySelector("#service-summary");
const submitButton = document.querySelector("#submit-booking");
const errorMessage = document.querySelector("#booking-error");
const confirmation = document.querySelector("#booking-confirmation");
let services = [];
let availabilityRequest;
let selectedTime = "";

function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nextOpenDate() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  while (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return localDate(date);
}

function formatPrice(price) {
  return `$${Number(price).toLocaleString("es-CO")}`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
  return data;
}

function updateSubmitState() {
  submitButton.disabled = !form.checkValidity() || !selectedTime;
}

function renderServiceSummary() {
  const service = services.find((item) => item.id === serviceSelect.value);
  if (!service) {
    serviceSummary.hidden = true;
    return;
  }
  serviceSummary.textContent = `${service.durationMinutes} minutos · ${formatPrice(service.price)}`;
  serviceSummary.hidden = false;
}

function selectSlot(time) {
  selectedTime = time;
  timeInput.value = time;
  slotsGrid.querySelectorAll(".slot-button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.time === time));
  });
  errorMessage.textContent = "";
  updateSubmitState();
}

async function loadAvailability() {
  selectedTime = "";
  timeInput.value = "";
  slotsGrid.replaceChildren();
  updateSubmitState();

  if (!serviceSelect.value || !barberSelect.value || !dateInput.value) {
    availabilityMessage.textContent = "Selecciona servicio, barbero y fecha para ver los horarios.";
    return;
  }

  if (availabilityRequest) availabilityRequest.abort();
  availabilityRequest = new AbortController();
  availabilityMessage.textContent = "Buscando horarios disponibles...";

  const query = new URLSearchParams({
    date: dateInput.value,
    serviceId: serviceSelect.value,
    barberId: barberSelect.value,
  });
  try {
    const data = await requestJson(`/api/availability?${query}`, { signal: availabilityRequest.signal });
    slotsGrid.replaceChildren();
    if (!data.slots.length) {
      availabilityMessage.textContent = "No hay horarios disponibles para esta fecha. Prueba otro día.";
      return;
    }

    availabilityMessage.textContent = "Elige uno de estos horarios:";
    data.slots.forEach((time) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "slot-button";
      button.textContent = time;
      button.dataset.time = time;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => selectSlot(time));
      slotsGrid.append(button);
    });
  } catch (error) {
    if (error.name === "AbortError") return;
    availabilityMessage.textContent = "No pudimos consultar los horarios. Intenta de nuevo.";
    errorMessage.textContent = error.message;
  }
}

async function initialize() {
  const today = localDate();
  const maximum = new Date();
  maximum.setDate(maximum.getDate() + 60);
  dateInput.min = today;
  dateInput.max = localDate(maximum);
  dateInput.value = nextOpenDate();

  try {
    const [serviceList, barberList] = await Promise.all([
      requestJson("/api/services"),
      requestJson("/api/barbers"),
    ]);
    services = serviceList;
    serviceSelect.innerHTML = '<option value="">Selecciona un servicio</option>' + serviceList.map((service) =>
      `<option value="${service.id}">${service.name} · ${formatPrice(service.price)}</option>`).join("");
    barberSelect.innerHTML = '<option value="">Selecciona un barbero</option>' + barberList.map((barber) =>
      `<option value="${barber.id}">${barber.name}</option>`).join("");
    await loadAvailability();
  } catch (error) {
    availabilityMessage.textContent = "No pudimos conectar con el sistema de reservas.";
    errorMessage.textContent = `${error.message} Recarga la página para volver a intentar.`;
    serviceSelect.innerHTML = '<option value="">Servicios no disponibles</option>';
    barberSelect.innerHTML = '<option value="">Barberos no disponibles</option>';
  }
}

serviceSelect.addEventListener("change", () => {
  renderServiceSummary();
  loadAvailability();
});
barberSelect.addEventListener("change", loadAvailability);
dateInput.addEventListener("change", loadAvailability);
form.addEventListener("input", updateSubmitState);
form.addEventListener("change", updateSubmitState);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedTime || !form.reportValidity()) return;

  submitButton.disabled = true;
  submitButton.querySelector("span").textContent = "Confirmando...";
  errorMessage.textContent = "";

  const values = new FormData(form);
  try {
    const { appointment, cancelToken } = await requestJson("/api/appointments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: values.get("name"),
        phone: values.get("phone"),
        email: values.get("email"),
        consent: values.get("consent") === "on",
        serviceId: values.get("serviceId"),
        barberId: values.get("barberId"),
        date: values.get("date"),
        time: values.get("time"),
      }),
    });

    const date = new Date(`${appointment.date}T12:00:00`).toLocaleDateString("es-CO", {
      weekday: "long", day: "numeric", month: "long",
    });
    document.querySelector("#confirmation-copy").textContent =
      `Solicitud para ${appointment.service} con ${appointment.barber}, el ${date} a las ${appointment.time}. Se guardó en este computador.`;
    document.querySelector("#confirmation-id").textContent = appointment.id.slice(0, 8).toUpperCase();
    const cancellationLink = document.querySelector("#cancel-appointment-link");
    cancellationLink.href = `/cancelar?token=${encodeURIComponent(cancelToken)}`;
    form.hidden = true;
    document.querySelector(".booking-intro").hidden = true;
    document.querySelector(".booking-aside").hidden = true;
    confirmation.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    errorMessage.textContent = error.message;
    if (error.message.includes("ocupado")) await loadAvailability();
    updateSubmitState();
  } finally {
    if (!form.hidden) {
      submitButton.querySelector("span").textContent = "Guardar solicitud";
      updateSubmitState();
    }
  }
});

document.querySelector("#copy-cancellation-link").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(document.querySelector("#cancel-appointment-link").href);
    button.textContent = "Enlace copiado";
  } catch (error) {
    console.warn("El navegador no permitió copiar el enlace de cancelación.", error);
    button.textContent = "Copia el enlace desde el botón de cancelar";
  }
});

initialize();
