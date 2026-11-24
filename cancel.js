const token = new URLSearchParams(window.location.search).get("token");
const title = document.querySelector("#cancel-title");
const message = document.querySelector("#cancel-message");
const details = document.querySelector("#cancel-details");
const cancelButton = document.querySelector("#cancel-button");
const errorMessage = document.querySelector("#cancel-error");
let canCancel = false;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo completar la solicitud.");
  return data;
}

function showAppointment(appointment) {
  const [year, month, day] = appointment.date.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12).toLocaleDateString("es-CO", {
    weekday: "long", day: "numeric", month: "long",
  });
  document.querySelector("#cancel-service").textContent = appointment.service;
  document.querySelector("#cancel-barber").textContent = appointment.barber;
  document.querySelector("#cancel-datetime").textContent = `${date} · ${appointment.time}`;
  details.hidden = false;
}

async function loadCancellation() {
  if (!token) {
    title.textContent = "Enlace incompleto";
    message.textContent = "Abre el enlace de cancelación que recibiste al guardar tu solicitud.";
    return;
  }

  try {
    const data = await requestJson(`/api/cancellations/${encodeURIComponent(token)}`);
    showAppointment(data.appointment);
    if (data.appointment.status === "Cancelada") {
      title.textContent = "Esta cita ya está cancelada";
      message.textContent = "Este horario se liberó en el sistema local. La barbería no recibe una notificación.";
      return;
    }

    title.textContent = "¿Quieres cancelar tu cita?";
    if (data.canCancel) {
      canCancel = true;
      message.textContent = "Confirma para cancelar la reserva y liberar el horario para otro cliente.";
      cancelButton.hidden = false;
      return;
    }

    message.textContent = "La cancelación en línea debe hacerse al menos 2 horas antes de la cita. Comunícate directamente con la barbería para solicitar ayuda.";
  } catch (error) {
    title.textContent = "No encontramos esta reserva";
    message.textContent = error.message;
  }
}

cancelButton.addEventListener("click", async () => {
  if (!canCancel || !window.confirm("¿Confirmas que quieres cancelar esta cita?")) return;
  cancelButton.disabled = true;
  cancelButton.textContent = "Cancelando...";
  errorMessage.textContent = "";

  try {
    await requestJson(`/api/cancellations/${encodeURIComponent(token)}`, { method: "POST" });
    canCancel = false;
    cancelButton.hidden = true;
    document.querySelector("#cancel-mark").classList.add("success");
    document.querySelector("#cancel-mark").textContent = "✓";
    title.textContent = "Cita cancelada";
    message.textContent = "Listo. El horario quedó libre en el sistema local. Contacta a la barbería para confirmar el cambio.";
  } catch (error) {
    errorMessage.textContent = error.message;
    cancelButton.disabled = false;
    cancelButton.textContent = "Cancelar esta cita";
  }
});

loadCancellation();
