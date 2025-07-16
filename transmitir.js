const fs = require('fs');
const { spawn } = require('child_process');
const puppeteer = require('puppeteer');

const videoFile = 'video_final_completo.mp4';
const infoFile = 'stream_info.json';
const SERVER_STATUS_URL = process.env.SERVER_STATUS_URL || '';

async function enviarStatusViaPuppeteer(payload) {
  if (!SERVER_STATUS_URL) {
    console.warn('⚠️ SERVER_STATUS_URL não definido, status não enviado.');
    return;
  }

  console.log('📡 Abrindo navegador para envio de status...');
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 20000 });

    const result = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const text = await res.text();
        return {
          ok: res.ok,
          status: res.status,
          text: text
        };
      } catch (e) {
        return {
          ok: false,
          error: e.message
        };
      }
    }, payload);

    await browser.close();

    if (result.ok) {
      console.log(`✅ Status enviado com sucesso: ${payload.status}`);
      if (result.text) {
        console.log(`📥 Resposta do servidor: ${result.text}`);
      }
    } else {
      console.error(`❌ Erro ao enviar status. HTTP ${result.status || 'N/A'}: ${result.text || result.error}`);
    }
  } catch (err) {
    console.error('❌ Erro ao usar Puppeteer:', err.message);
  }
}

async function transmitir() {
  if (!fs.existsSync(infoFile)) {
    console.error('❌ Arquivo stream_info.json não encontrado!');
    process.exit(1);
  }

  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  const streamUrl = info.stream_url;
  const id = info.id || 'desconhecido';

  if (!streamUrl) {
    console.error('❌ stream_url não definida!');
    await enviarStatusViaPuppeteer({ id, status: 'error', message: 'URL de transmissão ausente' });
    process.exit(1);
  }

  if (!fs.existsSync(videoFile)) {
    console.error(`❌ Vídeo "${videoFile}" não encontrado!`);
    await enviarStatusViaPuppeteer({ id, status: 'error', message: 'Arquivo de vídeo não encontrado' });
    process.exit(1);
  }

  console.log('▶️ Iniciando transmissão...');
  const ffmpeg = spawn('ffmpeg', [
    '-re',
    '-i', videoFile,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'flv',
    streamUrl
  ], { stdio: 'inherit' });

  // Esperar 60s antes de enviar o status "started"
  setTimeout(() => {
    enviarStatusViaPuppeteer({ id, status: 'started' });
  }, 60000);

  ffmpeg.on('close', async (code) => {
    if (code === 0) {
      console.log('✅ Transmissão concluída com sucesso.');
      await enviarStatusViaPuppeteer({ id, status: 'finished' });
    } else {
      console.error(`🚨 Erro na transmissão (código ${code})`);
      await enviarStatusViaPuppeteer({
        id,
        status: 'error',
        message: `FFmpeg falhou com código ${code}`
      });
    }
  });
}

transmitir().catch(async (err) => {
  console.error('🚨 Erro fatal:', err.message);
  await enviarStatusViaPuppeteer({ id: 'desconhecido', status: 'error', message: err.message });
  process.exit(1);
});
