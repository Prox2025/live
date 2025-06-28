const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php'; // corrigido (%20)

// Autentica com Google API
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: SCOPES,
  });
  return await auth.getClient();
}

// Faz o download do vídeo
async function baixarVideo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando vídeo ID ${fileId} para ${dest}...`);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    let tamanho = 0;

    res.data.on('data', chunk => tamanho += chunk.length);
    res.data.pipe(destStream);

    destStream.on('finish', () => {
      console.log(`✅ Download concluído (${(tamanho / 1024 / 1024).toFixed(2)} MB)`);
      resolve();
    });

    destStream.on('error', err => {
      console.error('❌ Erro ao salvar vídeo:', err);
      reject(err);
    });
  });
}

// Envia status para o servidor via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // Emula o fuso horário de Moçambique
    await page.emulateTimezone('Africa/Maputo');

    console.log(`🌐 Acessando ${SERVER_STATUS_URL}`);
    await page.goto(SERVER_STATUS_URL, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Aguarda o JS do servidor ser carregado
    await new Promise(resolve => setTimeout(resolve, 3000));

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
        return { status: 500, texto: 'Erro interno no fetch: ' + e.message };
      }
    }, data);

    console.log("📡 Resposta do servidor:", resposta);
    await browser.close();
    return resposta;
  } catch (err) {
    console.error("❌ Erro ao enviar status:", err.message);
    await browser.close();
    throw err;
  }
}

// Transmite vídeo com ffmpeg
async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re', '-i', inputFile,
      '-vf', 'scale=1280:720,unsharp=5:5:1.0:5:5:0.0,hqdn3d=1.5:1.5:6:6,eq=contrast=1.1:brightness=0.05:saturation=1.1',
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
    ]);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notifiedStart = false;

    // Notifica que começou após 60 segundos
    const timer = setTimeout(async () => {
      if (!notifiedStart) {
        const id = path.basename(inputFile, '.mp4');
        console.log('🔔 Notificando início da live...');
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notifiedStart = true;
          console.log('✅ Início da live notificado');
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e);
        }
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');

      if (code === 0) {
        console.log('✅ Live finalizada. Notificando término...');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.error('⚠️ Erro ao notificar término:', e);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg finalizou com erro (código ${code})`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg finalizou com erro (código ${code})`));
      }

      try {
        fs.unlinkSync(inputFile);
        console.log('🧹 Arquivo de vídeo removido');
      } catch (e) {
        console.warn('⚠️ Erro ao excluir vídeo:', e.message);
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      console.error('❌ Erro no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

// Executa tudo
async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('❌ JSON de entrada não encontrado:', jsonPath);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) {
      throw new Error('JSON deve conter id, video_drive_id, stream_url e chave_json');
    }

    // Salva chave em disco temporariamente
    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, chave_json);

    console.log(`🚀 Iniciando live para vídeo ID: ${id}`);

    const videoFile = path.join(process.cwd(), `${id}.mp4`);
    await baixarVideo(video_drive_id, videoFile, keyFilePath);

    await rodarFFmpeg(videoFile, stream_url);

    fs.unlinkSync(keyFilePath);
  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
