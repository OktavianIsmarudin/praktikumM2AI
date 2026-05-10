require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');

const RAGEngine = require('./lib/rag');
const DatasetManager = require('./lib/dataset');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const ragEngine = new RAGEngine();
const datasetManager = new DatasetManager();

let client = null;
let qrCodeData = null;
let isReady = false;
let isCleaning = false;
let isInitializing = false;
const handledMessageIds = new Set();

const knowledgeFile = path.join(__dirname, 'knowledge.json');

if (!fs.existsSync(knowledgeFile)) {
  fs.writeFileSync(knowledgeFile, JSON.stringify({ keywords: {}, responses: {} }, null, 2));
}

function loadKnowledge() {
  try {
    const data = fs.readFileSync(knowledgeFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error loading knowledge:', error);
    return { keywords: {}, responses: {} };
  }
}

function saveKnowledge(data) {
  try {
    fs.writeFileSync(knowledgeFile, JSON.stringify(data, null, 2));
    ragEngine.clearCache();
    return true;
  } catch (error) {
    console.error('Error saving knowledge:', error);
    return false;
  }
}

async function getAIResponse(message, contextItems = []) {
  try {
    const contextBlock = ragEngine.buildContextBlock(contextItems);
    const userPrompt = contextBlock
      ? `Gunakan konteks berikut sebagai sumber utama jawaban. Jika konteks tidak cukup, katakan singkat bahwa informasi tidak ditemukan di basis pengetahuan. Jawab maksimal 2 kalimat, bahasa Indonesia.\n\nKonteks:\n${contextBlock}\n\nPertanyaan user: ${message}`
      : `Jawab singkat 1-2 kalimat, bahasa Indonesia. Jika tidak yakin, katakan belum ada di basis pengetahuan.\n\nPertanyaan: ${message}`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: userPrompt
        }
      ],
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      max_tokens: Number(process.env.GROQ_MAX_TOKENS || 200),
      temperature: 0.5
    });
    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error getting AI response:', error.message);
    return null;
  }
}

async function startBot() {
  if (isReady || isInitializing) {
    return { success: false, message: 'Bot sudah berjalan atau sedang dimulai' };
  }

  if (isCleaning) {
    return { success: false, message: 'Bot sedang dihentikan, harap tunggu' };
  }

  isInitializing = true;

  try {
    const clientInstance = initializeClient();
    await clientInstance.initialize();
    isInitializing = false;
    return { success: true, message: 'Bot dimulai, silakan scan QR code' };
  } catch (error) {
    isInitializing = false;
    client = null;
    qrCodeData = null;
    isCleaning = false;
    throw error;
  }
}

function initializeClient() {
  if (client) return client;
  
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'whatsapp-bot' }),
    puppeteer: { 
      headless: true, 
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-resources',
        '--disable-sync',
        '--disable-translate',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages'
      ],
      timeout: 120000
    }
  });

  client.on('qr', (qr) => {
    console.log('📱 QR Code Generated');
    console.log('\n🔗 Scan QR Code di bawah untuk connect bot:\n');
    qrCodeData = qr;
    qrcode.generate(qr, { small: true });
    console.log('\n');
  });

  client.on('ready', () => {
    console.log('✅ Bot is ready!');
    isReady = true;
    isCleaning = false;
  });

  client.on('authenticated', () => {
    console.log('🔐 Client authenticated');
  });

  client.on('disconnected', (reason) => {
    console.log('❌ Client disconnected:', reason);
    isReady = false;
    client = null;
  });

  const handleIncomingMessage = async (msg, eventName) => {
    try {
      console.log(
        `📩 ${eventName} event: from=${msg.from}, fromMe=${msg.fromMe}, body=${JSON.stringify(msg.body)}`
      );

      const messageId = msg && msg.id && msg.id._serialized ? msg.id._serialized : null;
      if (messageId) {
        if (handledMessageIds.has(messageId)) {
          console.log('↪️ Ignoring duplicate event for same message');
          return;
        }

        handledMessageIds.add(messageId);
        setTimeout(() => handledMessageIds.delete(messageId), 5 * 60 * 1000);
      }

      if (msg.fromMe) {
        console.log('↪️ Ignoring self-sent message to avoid reply loop');
        return;
      }

      const isPersonalChat = msg.from.endsWith('@c.us') || msg.from.endsWith('@lid');
      const isNotStatus = !msg.from.endsWith('@status');
      if (!isPersonalChat || !isNotStatus) {
        console.log(`↪️ Ignoring non-personal or status message: from=${msg.from}`);
        return;
      }

      console.log(`📨 Personal Message from ${msg.from}: ${msg.body}`);
      try {
        await msg.getChat().then(chat => chat.sendStateTyping());
      } catch (e) {
        console.log('Note: Cannot show typing indicator');
      }
      
      const knowledge = loadKnowledge();
      const keyword = msg.body.toLowerCase().trim();
      if (knowledge.responses[keyword]) {
        await msg.reply(knowledge.responses[keyword]);
        console.log('✅ Replied with FAQ keyword match');
      } else {
        const allDocuments = datasetManager.getAllDocuments();
        const contextItems = ragEngine.retrieveContext(
          msg.body,
          allDocuments,
          Number(process.env.RAG_TOP_K || 3)
        );

        console.log(`🔍 RAG Retrieved ${contextItems.length} relevant context(s)`);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('AI response timeout')), 15000)
        );
        
        try {
          const aiResponse = await Promise.race([
            getAIResponse(msg.body, contextItems),
            timeoutPromise
          ]);
          
          if (aiResponse) {
            await msg.reply(aiResponse);
            console.log(`🤖 Replied with AI response (RAG contexts: ${contextItems.length})`);
          } else {
            await msg.reply('Maaf, saya tidak memahami pesan Anda. Silakan coba lagi.');
          }
        } catch (aiError) {
          console.error('AI Error:', aiError.message);
          await msg.reply('Maaf, terjadi kesalahan dalam memproses pesan. Silakan coba lagi.');
        }
      }
    } catch (error) {
      console.error('Message handler error:', error.message);
    }
  };

  client.on('message', (msg) => handleIncomingMessage(msg, 'message'));
  client.on('message_create', (msg) => handleIncomingMessage(msg, 'message_create'));

  return client;
}

app.get('/api/bot/status', (req, res) => {
  res.json({
    isReady,
    isCleaning,
    isInitializing,
    hasQRCode: qrCodeData ? true : false
  });
});

app.post('/api/bot/start', async (req, res) => {
  try {
    const result = await startBot();
    return res.json(result);
  } catch (error) {
    console.error('Error starting bot:', error.message);
    res.status(500).json({ 
      message: 'Error memulai bot. Pastikan koneksi internet stabil dan coba lagi.', 
      success: false 
    });
  }
});

app.post('/api/bot/stop', async (req, res) => {
  try {
    if (!client) {
      return res.json({ message: 'Bot tidak sedang berjalan', success: false });
    }
    
    isCleaning = true;
    isReady = false;
    qrCodeData = null;

    const clientToDestroy = client;
    client = null;

    res.json({ message: 'Bot sudah dihentikan', success: true });

    setImmediate(async () => {
      try {
        await clientToDestroy.destroy();
      } catch (destroyError) {
        console.error('Error destroying client:', destroyError.message);
      } finally {
        isCleaning = false;
      }
    });
  } catch (error) {
    console.error('Error stopping bot:', error);
    isCleaning = false;
    res.status(500).json({ message: 'Error menghentikan bot: ' + error.message, success: false });
  }
});

app.get('/api/bot/qr', (req, res) => {
  if (qrCodeData) {
    res.json({ qr: qrCodeData });
  } else {
    res.json({ qr: null });
  }
});

app.get('/api/datasets', (req, res) => {
  res.json({
    datasets: datasetManager.listDatasets(),
    totalDocuments: datasetManager.getAllDocuments().length
  });
});

app.get('/api/datasets/:name', (req, res) => {
  const docs = datasetManager.getDatasetDocuments(req.params.name);
  if (docs.length === 0) {
    return res.status(404).json({ message: 'Dataset tidak ditemukan' });
  }
  res.json({ documents: docs });
});

app.post('/api/datasets', (req, res) => {
  try {
    const { name, data } = req.body;
    
    if (!name || !data) {
      return res.status(400).json({ message: 'name dan data harus diisi' });
    }
    
    const result = datasetManager.saveDataset(name, data);
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message });
  }
});

app.get('/api/knowledge/keywords', (req, res) => {
  const knowledge = loadKnowledge();
  res.json(knowledge);
});

app.post('/api/knowledge/keyword', (req, res) => {
  try {
    const { keyword, response } = req.body;
    
    if (!keyword || !response) {
      return res.status(400).json({ message: 'Keyword dan response harus diisi', success: false });
    }
    
    const knowledge = loadKnowledge();
    knowledge.responses[keyword.toLowerCase().trim()] = response;
    
    if (saveKnowledge(knowledge)) {
      res.json({ message: 'Keyword berhasil disimpan', success: true });
    } else {
      res.status(500).json({ message: 'Error menyimpan keyword', success: false });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message, success: false });
  }
});

app.delete('/api/knowledge/keyword/:keyword', (req, res) => {
  try {
    const keyword = decodeURIComponent(req.params.keyword).toLowerCase();
    const knowledge = loadKnowledge();
    
    if (knowledge.responses[keyword]) {
      delete knowledge.responses[keyword];
      if (saveKnowledge(knowledge)) {
        res.json({ message: 'Keyword berhasil dihapus', success: true });
      } else {
        res.status(500).json({ message: 'Error menghapus keyword', success: false });
      }
    } else {
      res.status(404).json({ message: 'Keyword tidak ditemukan', success: false });
    }
  } catch (error) {
    res.status(500).json({ message: 'Error: ' + error.message, success: false });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`📊 Admin Dashboard: http://localhost:${PORT}`);
  console.log(`📊 Datasets loaded: ${datasetManager.listDatasets().length}`);

  if (process.env.AUTO_START_BOT !== 'false') {
    setTimeout(() => {
      startBot().catch(error => {
        console.error('Error auto-starting bot:', error.message);
      });
    }, 500);
  }
});
