require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { body, validationResult } = require("express-validator");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

let supabase;
function getSupabase() {
  if (!supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be configured");
    }
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  }
  return supabase;
}

app.use(express.json());
app.use(
  cors({
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",")
      : true,
  })
);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.static(path.join(__dirname, "public")));

const leadsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Muitas requisições, tente novamente mais tarde" },
});

async function sendEvolutionMessage(number, text) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`;

  const response = await axios.post(
    url,
    { number, text, linkPreview: true },
    {
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.EVOLUTION_API_KEY,
      },
    }
  );

  return response.data;
}

function buildWelcomeText(clientName) {
  return `Olá ${clientName}! 👋\n\nAqui é a equipe da *Antigravity*! Que bom ter você com a gente.\n\nVi que você tem interesse em automação com IA — e quero te mostrar como podemos transformar suas operações.\n\nPara isso, gostaria de agendar uma *reunião de diagnóstico gratuita* com você. São apenas 30 minutinhos! ⏱️\n\nQual o melhor dia e horário pra você esta semana? 📅`;
}

async function sendWelcomeMessage(clientName, clientPhone) {
  try {
    const text = buildWelcomeText(clientName);
    await sendEvolutionMessage(clientPhone, text);
    console.log(`Mensagem de boas-vindas enviada para ${clientPhone}`);
  } catch (error) {
    console.error("Falha ao enviar mensagem de boas-vindas:", error.message);
  }
}

async function sendEchoToMaia(leadName, leadPhone, messageText) {
  try {
    await axios.post(
      'https://api.maiacompany.io/messages',
      {
        content: messageText,
        fromChannelIdentifier: '+554792621792',
        externalUserId: leadPhone,
        sessionId: leadPhone,
        sessionName: leadName,
        isEcho: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + process.env.MAIA_API_KEY,
        },
        timeout: 10000,
      }
    );
    console.log(`Echo enviado à Maia para ${leadPhone}`);
  } catch (error) {
    console.error('Falha ao enviar echo à Maia:', error.message);
  }
}

async function fireN8nWebhook(leadData, welcomeMessage) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await axios.post(webhookUrl, {
      name: leadData.name,
      email: leadData.email,
      whatsapp: leadData.whatsapp,
      welcomeMessage: welcomeMessage,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
    console.log('Webhook N8N disparado com sucesso');
  } catch (error) {
    console.error('Falha ao disparar webhook N8N:', error.message);
  }
}

async function sendOwnerNotification(leadData) {
  try {
    const text = `🔔 *Novo Lead Cadastrado!*\n\n👤 Nome: ${leadData.name}\n📧 Email: ${leadData.email}\n📱 WhatsApp: ${leadData.whatsapp}\n🕐 Data: ${new Date().toLocaleString("pt-BR")}`;
    await sendEvolutionMessage(process.env.OWNER_WHATSAPP_NUMBER, text);
    console.log("Notificação enviada ao proprietário");
  } catch (error) {
    console.error("Falha ao enviar notificação ao proprietário:", error.message);
  }
}

// ── Brazilian 9th digit normalization ──
// DDDs 11-27: mobile numbers HAVE the 9th digit (9xxxx-xxxx)
// DDDs 28+:   mobile numbers do NOT have the 9th digit (xxxx-xxxx)
function normalizeBrazilianNumber(number) {
  // Only process Brazilian numbers (starts with 55)
  if (!number.startsWith('55')) return { number, changed: false };

  const ddd = parseInt(number.substring(2, 4), 10);
  const local = number.substring(4);

  if (isNaN(ddd) || ddd < 11 || ddd > 99) return { number, changed: false };

  // DDD >= 28: should NOT have 9th digit → if 9 digits starting with 9, remove it
  if (ddd >= 28 && local.length === 9 && local.startsWith('9')) {
    const fixed = '55' + ddd + local.substring(1);
    return { number: fixed, changed: true };
  }

  // DDD <= 27: should HAVE 9th digit → if only 8 digits, prepend 9
  if (ddd <= 27 && local.length === 8 && !local.startsWith('9')) {
    const fixed = '55' + ddd + '9' + local;
    return { number: fixed, changed: true };
  }

  return { number, changed: false };
}

// ── Verify WhatsApp number via Evolution API ──
app.post("/api/verify-whatsapp", async (req, res) => {
  try {
    const rawNumber = (req.body.number || '').replace(/[^0-9]/g, '');

    if (!rawNumber || rawNumber.length < 10) {
      return res.status(400).json({ valid: false, message: "Número inválido" });
    }

    // Step 1: Try original number on Evolution API
    const evoUrl = `${process.env.EVOLUTION_API_URL}/chat/whatsappNumbers/${process.env.EVOLUTION_INSTANCE}`;
    const evoHeaders = {
      "Content-Type": "application/json",
      apikey: process.env.EVOLUTION_API_KEY,
    };

    let evoResponse;
    try {
      evoResponse = await axios.post(evoUrl, { numbers: [rawNumber] }, { headers: evoHeaders, timeout: 8000 });
    } catch (err) {
      console.error("Evolution API error:", err.message);
      // If Evolution API fails, apply DDD fallback and accept
      const fallback = normalizeBrazilianNumber(rawNumber);
      return res.json({ valid: true, number: fallback.number, corrected: fallback.changed, source: "fallback" });
    }

    const results = evoResponse.data;

    // Evolution API returns array of objects with 'exists' and 'jid' fields
    if (Array.isArray(results) && results.length > 0) {
      const result = results[0];

      // Number exists on WhatsApp
      if (result.exists) {
        // Extract the clean number from jid (format: "5591983261468@s.whatsapp.net")
        const jidNumber = result.jid ? result.jid.split('@')[0] : rawNumber;
        return res.json({ valid: true, number: jidNumber, corrected: jidNumber !== rawNumber, source: "evolution" });
      }
    }

    // Step 2: Number not found — try DDD fallback (add/remove 9th digit)
    const fallback = normalizeBrazilianNumber(rawNumber);

    if (fallback.changed) {
      // Try the corrected number on Evolution API
      try {
        const retryResponse = await axios.post(evoUrl, { numbers: [fallback.number] }, { headers: evoHeaders, timeout: 8000 });
        const retryResults = retryResponse.data;

        if (Array.isArray(retryResults) && retryResults.length > 0 && retryResults[0].exists) {
          const jidNumber = retryResults[0].jid ? retryResults[0].jid.split('@')[0] : fallback.number;
          return res.json({ valid: true, number: jidNumber, corrected: true, source: "evolution-retry" });
        }
      } catch (err) {
        console.error("Evolution API retry error:", err.message);
        // Accept the fallback-corrected number anyway
        return res.json({ valid: true, number: fallback.number, corrected: true, source: "fallback" });
      }
    }

    // Step 3: Neither original nor corrected number found — not a real WhatsApp
    return res.json({ valid: false, number: rawNumber, message: "Este número não foi encontrado no WhatsApp." });

  } catch (error) {
    console.error("Erro na verificação WhatsApp:", error.message);
    // On unexpected errors, don't block the user — accept the number
    const fallback = normalizeBrazilianNumber((req.body.number || '').replace(/[^0-9]/g, ''));
    return res.json({ valid: true, number: fallback.number, corrected: fallback.changed, source: "error-fallback" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.post(
  "/api/leads",
  leadsLimiter,
  [
    body("name").trim().notEmpty().withMessage("Nome é obrigatório")
      .custom((value) => {
        const parts = value.trim().split(/\s+/);
        if (parts.length < 2 || parts.some(p => p.length < 2)) {
          throw new Error("Informe nome e sobrenome");
        }
        return true;
      }),
    body("email").trim().isEmail().withMessage("E-mail válido é obrigatório"),
    body("whatsapp").trim().notEmpty().withMessage("Número do WhatsApp é obrigatório"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { name, email } = req.body;
      // Normalize phone: strip everything except digits
      const whatsapp = (req.body.whatsapp || '').replace(/[^0-9]/g, '');

      if (!whatsapp) {
        return res.status(400).json({ success: false, message: "Número do WhatsApp inválido" });
      }

      const { error } = await getSupabase()
        .from("leads")
        .insert([{ name, email, whatsapp }]);

      if (error) {
        console.error("Erro ao inserir no Supabase:", error.message);
        return res
          .status(500)
          .json({ success: false, message: "Falha ao registrar lead" });
      }

      const welcomeText = buildWelcomeText(name);
      sendWelcomeMessage(name, whatsapp).then(() => {
        sendEchoToMaia(name, whatsapp, welcomeText);
      });
      sendOwnerNotification({ name, email, whatsapp });
      fireN8nWebhook({ name, email, whatsapp }, welcomeText);

      return res
        .status(201)
        .json({ success: true, message: "Lead registrado com sucesso" });
    } catch (error) {
      console.error("Erro inesperado:", error.message);
      return res
        .status(500)
        .json({ success: false, message: "Erro interno do servidor" });
    }
  }
);

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server only when running directly (not on Vercel)
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
