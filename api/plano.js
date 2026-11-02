// Lee la imagen de un plano de vivienda y devuelve sus estancias con forma y medidas.
// POST /api/plano  {image: "<jpeg en base64>", w, h}  ·  GET /api/plano → {ok} si está configurado.
// Necesita la variable de entorno ANTHROPIC_API_KEY en Vercel.
const AnthropicMod = require("@anthropic-ai/sdk");
const Anthropic = AnthropicMod.default || AnthropicMod;

const PROMPT = (w, h) => `Esta imagen (${w} × ${h} píxeles) es el plano de una vivienda.
Quiero reconstruir cada estancia para dibujarla en una app de planos.

Devuelve SOLO un objeto JSON, sin texto antes ni después, con esta forma:
{"cm_por_px": número, "estancias": [{"nombre": "Salón-cocina-comedor", "m2": 30.71, "puntos": [[x,y],[x,y],...]}]}

- "puntos": el contorno INTERIOR de cada estancia (la cara de dentro de sus paredes), en píxeles de esta imagen, con el origen arriba a la izquierda, siguiendo el contorno en orden. Usa ángulos rectos donde las paredes lo sean y pon solo las esquinas.
- "cm_por_px": cuántos centímetros reales mide un píxel. Calcúlalo con la barra de escala si la hay y compruébalo con las superficies en m² que indique el plano; si no hay ninguna de las dos, estímalo suponiendo puertas de 80 cm.
- "m2": la superficie que pone el plano para esa estancia, o null si no la pone.
- Incluye todas las estancias: salón, cocina, dormitorios, baños, pasillo o hall, terraza, tendedero…, con el nombre como aparece en el plano.
- No incluyas muebles, ni la tabla de superficies, ni el plano de situación.`;

module.exports = async (req, res) => {
  const ready = !!process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") return res.status(200).json({ ok: ready });
  if (req.method !== "POST") return res.status(405).json({ error: "Usa POST." });
  if (!ready) return res.status(501).json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel." });

  const { image, w, h } = req.body || {};
  if (typeof image !== "string" || image.length < 100 || image.length > 4_500_000) return res.status(400).json({ error: "La imagen no es válida o pesa demasiado." });

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: PROMPT(+w || 0, +h || 0) },
        ],
      }],
    });
    if (response.stop_reason === "refusal") return res.status(422).json({ error: "No se ha podido leer este plano." });
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: "No he entendido la respuesta. Prueba con una imagen más nítida." });
    let data;
    try { data = JSON.parse(m[0]); } catch { return res.status(502).json({ error: "No he entendido la respuesta. Prueba otra vez." }); }
    const estancias = (Array.isArray(data.estancias) ? data.estancias : [])
      .filter(e => Array.isArray(e.puntos) && e.puntos.length >= 3)
      .map(e => ({ nombre: String(e.nombre || "Estancia").slice(0, 60), m2: +e.m2 || null, puntos: e.puntos.map(p => [+p[0] || 0, +p[1] || 0]) }));
    return res.status(200).json({ cm_por_px: +data.cm_por_px || null, estancias });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "Demasiadas peticiones seguidas. Espera un minuto." });
    if (e instanceof Anthropic.AuthenticationError) return res.status(500).json({ error: "La clave ANTHROPIC_API_KEY no es válida." });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ error: `El lector de planos ha fallado (${e.status || "sin conexión"}).` });
    return res.status(500).json({ error: "El lector de planos ha fallado." });
  }
};
