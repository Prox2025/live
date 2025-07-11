const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || '';
const VIDEO_PATH = 'video_final_completo.mp4';
const STREAM_INFO_PATH = 'stream_info.json';

async function enviarStatus(statusObj) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');

    console.log(`🌐 Acessando API de status em ${SERVER_STATUS_URL}...`);
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Espera 3 segundos para garantir que a página esteja pronta
    await new Promise(r => setTimeout(r, 3000));

    const resposta = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const texto = await res.text();
        return { status: res.status, texto };
      } catch (err) {
        return { status: 500, texto: 'Erro interno: ' + err.message };
      }
    }, statusObj);

    console.log('📡 Resposta do servidor:', resposta);
    return resposta;
  } catch (err) {
    console.error('❌ Erro ao enviar status:', err.message);
    throw err;
  } finally {
    await browser.close();
  }
}

async function transmitirVideo(videoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-re',                 // lê em tempo real (simula streaming)
      '-i', videoPath,
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
      streamUrl,
    ];

    console.log('▶️ Iniciando ffmpeg para transmissão...');
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    let notificouInicio = false;

    const notificarInicio = async () => {
      if (!notificouInicio) {
        try {
          await enviarStatus({ id, status: 'started' });
          console.log('✅ Notificado início da transmissão');
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e.message);
        }
        notificouInicio = true;
      }
    };

    // Notifica assim que ffmpeg começar a processar
    ffmpeg.stderr.once('data', () => {
      notificarInicio();
    });

    // Fallback para notificar início após 60 segundos caso erro no evento
    const fallbackTimer = setTimeout(() => {
      notificarInicio();
    }, 60000);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    ffmpeg.on('close', async (code) => {
      clearTimeout(fallbackTimer);
      if (code === 0) {
        try {
          await enviarStatus({ id, status: 'finished' });
          console.log('✅ Notificado término da transmissão');
        } catch (e) {
          console.error('⚠️ Falha ao notificar término:', e.message);
        }
        resolve();
      } else {
        try {
          await enviarStatus({ id, status: 'error', message: `ffmpeg saiu com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg falhou com código ${code}`));
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(fallbackTimer);
      try {
        await enviarStatus({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    if (!fs.existsSync(VIDEO_PATH)) throw new Error(`${VIDEO_PATH} não encontrado.`);
    if (!fs.existsSync(STREAM_INFO_PATH)) throw new Error(`${STREAM_INFO_PATH} não encontrado.`);

    const streamInfoRaw = fs.readFileSync(STREAM_INFO_PATH, 'utf-8');
    let streamInfo;
    try {
      streamInfo = JSON.parse(streamInfoRaw);
    } catch {
      throw new Error('stream_info.json inválido.');
    }

    const { stream_url, id } = streamInfo;
    if (!stream_url) throw new Error('stream_url ausente em stream_info.json.');
    if (!id) throw new Error('id ausente em stream_info.json.');

    console.log(`🚀 Iniciando transmissão para ${stream_url} (id: ${id})`);
    await transmitirVideo(VIDEO_PATH, stream_url, id);
  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
