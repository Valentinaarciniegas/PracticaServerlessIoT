// Dashboard CocaTrace: lee la API (API Gateway + Lambda), dibuja las graficas y controla el LED.
const CFG = window.COCATRACE;
const API = CFG.API_URL.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);

let horas = 24;
let ultimoTs = null;
const graficas = {};

const formatoHora = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: false,
});
const formatoFecha = new Intl.DateTimeFormat("es-CO", {
  timeZone: "America/Bogota", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});

// Guardado local opcional (la clave y el rango); si el navegador lo bloquea, se ignora
const local = {
  leer(k) { try { return localStorage.getItem(k); } catch { return null; } },
  guardar(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

function color(variable) {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function hace(segundos) {
  if (segundos < 60) return `hace ${Math.max(0, Math.round(segundos))} s`;
  if (segundos < 3600) return `hace ${Math.round(segundos / 60)} min`;
  if (segundos < 86400) return `hace ${Math.round(segundos / 3600)} h`;
  return `hace ${Math.round(segundos / 86400)} d`;
}

function crearGrafica(id, nombre, unidad, colorVar, limite) {
  const c = color(colorVar);
  return new Chart($(id), {
    type: "line",
    data: {
      datasets: [
        { label: nombre, data: [], borderColor: c, backgroundColor: c + "22", fill: true,
          borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0.25 },
        { label: `Límite ${limite} ${unidad}`, data: [], borderColor: color("--alerta"),
          borderWidth: 1.5, borderDash: [6, 5], pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          ticks: {
            color: color("--tenue"), maxTicksLimit: 7,
            callback: (v) => (horas > 24 ? formatoFecha : formatoHora).format(new Date(v)),
          },
          grid: { display: false },
        },
        y: {
          ticks: { color: color("--tenue"), callback: (v) => `${v} ${unidad}` },
          grid: { color: color("--borde") },
        },
      },
      plugins: {
        legend: { labels: { color: color("--tenue"), boxWidth: 12, usePointStyle: true } },
        tooltip: {
          callbacks: {
            title: (items) => formatoFecha.format(new Date(items[0].parsed.x)),
            label: (item) => ` ${item.dataset.label}: ${item.parsed.y.toFixed(1)} ${unidad}`,
          },
        },
      },
    },
  });
}

function actualizarGrafica(g, puntos, limite) {
  g.data.datasets[0].data = puntos;
  g.data.datasets[1].data = puntos.length
    ? [{ x: puntos[0].x, y: limite }, { x: puntos[puntos.length - 1].x, y: limite }]
    : [];
  g.update();
}

function marcarTarjeta(id, valor, limite) {
  $(id).classList.toggle("fuera", valor > limite);
}

async function cargarLecturas() {
  try {
    const r = await fetch(`${API}/lecturas?horas=${horas}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();

    $("total").textContent = d.total.toLocaleString("es-CO");
    if (d.ultima) {
      ultimoTs = d.ultima.ts;
      $("temp").textContent = Number(d.ultima.temperatura).toFixed(1);
      $("hum").textContent = Number(d.ultima.humedad).toFixed(1);
      $("hora-ultima").textContent = formatoFecha.format(new Date(d.ultima.ts * 1000));
      marcarTarjeta("t-temp", d.ultima.temperatura, CFG.LIMITE_TEMPERATURA);
      marcarTarjeta("t-hum", d.ultima.humedad, CFG.LIMITE_HUMEDAD);
    } else {
      ultimoTs = null;
      $("temp").textContent = $("hum").textContent = "--";
      $("hora-ultima").textContent = "Sin datos en el período";
    }
    pintarHace();

    const puntosT = d.lecturas.map((x) => ({ x: x.ts * 1000, y: Number(x.temperatura) }));
    const puntosH = d.lecturas.map((x) => ({ x: x.ts * 1000, y: Number(x.humedad) }));
    actualizarGrafica(graficas.temp, puntosT, CFG.LIMITE_TEMPERATURA);
    actualizarGrafica(graficas.hum, puntosH, CFG.LIMITE_HUMEDAD);
    pintarTabla(d.lecturas.slice(-25).reverse());

    $("actualizado").textContent = `Actualizado ${formatoHora.format(new Date())}`;
  } catch (e) {
    $("actualizado").textContent = `No se pudo leer la API (${e.message})`;
  }
}

function pintarHace() {
  $("hace").textContent = ultimoTs ? hace(Date.now() / 1000 - ultimoTs) : "--";
}

function pintarTabla(filas) {
  const tbody = $("filas");
  if (!filas.length) {
    tbody.innerHTML = '<tr><td colspan="3" class="tenue">Sin lecturas en este período</td></tr>';
    return;
  }
  tbody.innerHTML = filas.map((x) => {
    const t = Number(x.temperatura), h = Number(x.humedad);
    return `<tr>
      <td>${formatoFecha.format(new Date(x.ts * 1000))}</td>
      <td class="${t > CFG.LIMITE_TEMPERATURA ? "fuera" : ""}">${t.toFixed(1)}</td>
      <td class="${h > CFG.LIMITE_HUMEDAD ? "fuera" : ""}">${h.toFixed(1)}</td>
    </tr>`;
  }).join("");
}

// ---- Actuador (LED) ----
let ledActual = null;

function pintarLed(estado) {
  ledActual = estado;
  $("foco").classList.toggle("on", estado === "on");
  $("estado-led").textContent = estado
    ? `Estado: ${estado === "on" ? "encendido" : "apagado"}`
    : "Estado: desconocido";
}

function pintarDispositivo(estado) {
  const p = $("dispositivo");
  const recienteOk = ultimoTs && Date.now() / 1000 - ultimoTs < 120;
  let clase = "gris", texto = "ESP32: sin información";
  if (estado === "conectado") {
    clase = "verde"; texto = "ESP32 conectado";
  } else if (estado === "desconectado") {
    clase = "rojo"; texto = "ESP32 desconectado";
  } else if (recienteOk) {
    clase = "verde"; texto = "ESP32 enviando datos";
  }
  p.className = `pildora ${clase}`;
  p.querySelector("span").textContent = texto;
}

async function cargarLed() {
  try {
    const r = await fetch(`${API}/led`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    pintarLed(d.led ? d.led.led : null);
    pintarDispositivo(d.dispositivo);
    return d.led ? d.led.led : null;
  } catch {
    pintarDispositivo(null);
    return null;
  }
}

function mensajeLed(texto, tipo = "") {
  const m = $("mensaje-led");
  m.textContent = texto;
  m.className = `mensaje ${tipo}`;
}

async function enviarOrden(led) {
  const clave = $("clave").value.trim();
  if (!clave) {
    mensajeLed("Escribe la clave de control.", "error");
    $("clave").focus();
    return;
  }
  local.guardar("cocatrace-clave", clave);
  const botones = [$("led-on"), $("led-off")];
  botones.forEach((b) => (b.disabled = true));
  mensajeLed("Enviando la orden a AWS IoT…");
  try {
    const r = await fetch(`${API}/led`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-clave-control": clave },
      body: JSON.stringify({ led: led }),
    });
    if (r.status === 401) throw new Error("Clave de control incorrecta");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    // Espera a que el ESP32 confirme el nuevo estado (topic led/estado)
    mensajeLed("Orden enviada. Esperando confirmación del ESP32…");
    for (let i = 0; i < 8; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      if ((await cargarLed()) === led) {
        mensajeLed(`El ESP32 confirmó: LED ${led === "on" ? "encendido" : "apagado"}.`, "ok");
        return;
      }
    }
    mensajeLed("La orden quedó guardada. El ESP32 la aplicará cuando se conecte.", "error");
  } catch (e) {
    mensajeLed(e.message, "error");
  } finally {
    botones.forEach((b) => (b.disabled = false));
  }
}

// ---- Inicio ----
function cambiarRango(nuevas) {
  horas = nuevas;
  local.guardar("cocatrace-horas", String(horas));
  document.querySelectorAll(".rango button").forEach((b) =>
    b.classList.toggle("activo", Number(b.dataset.horas) === horas));
  $("descargar").href = `${API}/csv?horas=${horas}`;
  cargarLecturas();
}

function iniciar() {
  $("subtitulo").textContent = `Secado de hoja de coca · ${CFG.SECADERO}`;
  document.querySelectorAll(".lim-t").forEach((e) => (e.textContent = CFG.LIMITE_TEMPERATURA));
  document.querySelectorAll(".lim-h").forEach((e) => (e.textContent = CFG.LIMITE_HUMEDAD));
  $("clave").value = local.leer("cocatrace-clave") || "";

  graficas.temp = crearGrafica("g-temp", "Temperatura", "°C", "--temp", CFG.LIMITE_TEMPERATURA);
  graficas.hum = crearGrafica("g-hum", "Humedad", "%", "--hum", CFG.LIMITE_HUMEDAD);

  document.querySelectorAll(".rango button").forEach((b) =>
    b.addEventListener("click", () => cambiarRango(Number(b.dataset.horas))));
  $("led-on").addEventListener("click", () => enviarOrden("on"));
  $("led-off").addEventListener("click", () => enviarOrden("off"));

  cambiarRango(Number(local.leer("cocatrace-horas")) || 24);
  cargarLed();
  setInterval(() => { cargarLecturas(); cargarLed(); }, CFG.REFRESCO_S * 1000);
  setInterval(pintarHace, 1000);
}

iniciar();
