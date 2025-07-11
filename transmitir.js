const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const VIDEO_PATH = 'video_final_completo.mp4';
const STREAM_INFO_PATH = 'stream_info.json';
const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || '';

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

function transmitirParaFacebook(videoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const args = [
      '-re',
      '-i', videoPath,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-maxrate', '3000k',
      '-bufsize', '6000k',
      '-pix_fmt', 'yuv420p',
      '-g', '50',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-f', 'flv',
      streamUrl
    ];

    console.log(`🚀 Iniciando transmissão para: ${streamUrl}`);
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });

    ffmpeg.on('close', async (code) => {
      if (code === 0) {
        console.log('✅ Transmissão finalizada com sucesso.');
        await enviarStatus({ id, status: 'finished' });
        resolve();
      } else {
        console.error(`❌ FFmpeg finalizado com erro (código ${code})`);
        await enviarStatus({ id, status: 'error', message: `FFmpeg finalizou com código ${code}` });
        reject(new Error(`FFmpeg erro: código ${code}`));
      }
    });
  });
}

async function iniciarTransmissao() {
  if (!fs.existsSync(STREAM_INFO_PATH)) {
    console.error(`❌ Arquivo ${STREAM_INFO_PATH} não encontrado.`);
    process.exit(1);
  }

  if (!fs.existsSync(VIDEO_PATH)) {
    console.error(`❌ Arquivo de vídeo ${VIDEO_PATH} não encontrado.`);
    process.exit(1);
  }

  const streamInfo = JSON.parse(fs.readFileSync(STREAM_INFO_PATH, 'utf-8'));
  const { stream_url: streamUrl, id } = streamInfo;

  if (!streamUrl || !streamUrl.startsWith('rtmp')) {
    console.error('❌ stream_url inválido no stream_info.json');
    process.exit(1);
  }

  try {
    await enviarStatus({ id, status: 'started' });
    await transmitirParaFacebook(VIDEO_PATH, streamUrl, id);
  } catch (err) {
    console.error('🚨 Erro durante a transmissão:', err.message);
    process.exit(1);
  }
}

iniciarTransmissao();
