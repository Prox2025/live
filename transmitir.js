const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL;

if (!SERVER_STATUS_URL) {
  console.error('❌ Variável SERVER_STATUS_URL não definida');
  process.exit(1);
}

async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');

    console.log(`🌐 Acessando API de status em ${SERVER_STATUS_URL}...`);
    await page.goto(SERVER_STATUS_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Aguarda carregamento extra para garantir que tudo esteja pronto
    await new Promise(r => setTimeout(r, 3000));

    const resposta = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const texto = await res.text();
        return { status: res.status, texto };
      } catch (e) {
        return { status: 500, texto: 'Erro interno: ' + e.message };
      }
    }, data);

    console.log("📡 Resposta do servidor:", resposta);
    return resposta;
  } catch (err) {
    console.error("❌ Erro ao enviar status:", err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

async function rodarFFmpeg(videoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-i', videoPath,               // sem -re para leitura acelerada e garantir transmissão completa
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-maxrate', '3500k',
      '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-f', 'flv',
      streamUrl
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let notificadoInicio = false;

    const notificarInicio = async () => {
      if (!notificadoInicio) {
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          console.log('✅ Notificado início da transmissão');
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e.message);
        }
        notificadoInicio = true;
      }
    };

    ffmpeg.stderr.once('data', () => {
      notificarInicio();
    });

    const fallbackTimer = setTimeout(() => {
      notificarInicio();
    }, 60000);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    ffmpeg.on('close', async (code) => {
      clearTimeout(fallbackTimer);

      if (code === 0) {
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
          console.log('✅ Notificado término da transmissão com sucesso');
        } catch (e) {
          console.error('⚠️ Falha ao notificar término:', e.message);
        }
        resolve();
      } else {
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg saiu com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg erro ${code}`));
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(fallbackTimer);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    const streamInfoPath = path.join(process.cwd(), 'stream_info.json');
    const videoPathWebm = path.join(process.cwd(), 'video_final_completo.webm');

    if (!fs.existsSync(videoPathWebm)) {
      throw new Error('video_final_completo.webm não encontrado');
    }

    if (!fs.existsSync(streamInfoPath)) {
      throw new Error('stream_info.json não encontrado');
    }

    const infoRaw = fs.readFileSync(streamInfoPath, 'utf-8');
    let info;
    try {
      info = JSON.parse(infoRaw);
    } catch {
      throw new Error('stream_info.json inválido');
    }

    const { stream_url, id, video_id } = info;
    const liveId = id || video_id;

    if (!stream_url) throw new Error('stream_url ausente no stream_info.json');
    if (!liveId) throw new Error('id ausente no stream_info.json');

    console.log(`🚀 Iniciando transmissão para ${stream_url} (id: ${liveId}) usando arquivo ${path.basename(videoPathWebm)}`);

    await rodarFFmpeg(videoPathWebm, stream_url, liveId);

  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
