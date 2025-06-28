const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

// Autenticação Google API
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  return await auth.getClient();
}

// Baixar arquivo do Google Drive
async function baixarArquivo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(dest);
    res.data.pipe(stream);
    res.data.on('error', reject);
    stream.on('finish', resolve);
  });
}

// Obter duração do vídeo
function obterDuracaoVideo(filePath) {
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString();
    return parseFloat(output.trim());
  } catch (e) {
    return 0;
  }
}

// Enviar status para servidor via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2' });
    await page.evaluate((d) => fetch(window.location.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(d)
    }), data);
  } finally {
    await browser.close();
  }
}

// Gerar lista de concatenação do ffmpeg
function gerarListaConcat(videos, listaPath) {
  const conteudo = videos.map(v => `file '${v}'`).join('\n');
  fs.writeFileSync(listaPath, conteudo);
}

// Executar transmissão única com ffmpeg
function rodarFFmpeg(videoListPath, logoPath, streamUrl, id) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', videoListPath,
      '-i', logoPath,
      '-filter_complex',
      '[1:v] scale=80:-1 [logo]; [0:v][logo] overlay=W-w-30:30,scale=1280:720',
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

    const ffmpeg = spawn('ffmpeg', args);

    let notifiedStart = false;

    // Timer para notificar início após 60s
    const startTimer = setTimeout(async () => {
      if (!notifiedStart) {
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notifiedStart = true;
          console.log('✅ Início da live notificado');
        } catch (e) {
          console.warn('⚠️ Falha ao notificar início:', e.message);
        }
      }
    }, 60000);

    ffmpeg.stdout.on('data', d => process.stdout.write(d));
    ffmpeg.stderr.on('data', d => process.stderr.write(d));

    ffmpeg.on('close', async (code) => {
      clearTimeout(startTimer);
      if (!notifiedStart) {
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notifiedStart = true;
        } catch (_) {}
      }

      if (code === 0) {
        console.log('✅ Transmissão finalizada com sucesso');
        try {
          await enviarStatusPuppeteer({ id, status: 'finished' });
        } catch (e) {
          console.warn('⚠️ Erro ao notificar término:', e.message);
        }
        resolve();
      } else {
        console.error(`❌ ffmpeg finalizou com código ${code}`);
        try {
          await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg finalizou com código ${code}` });
        } catch (_) {}
        reject(new Error(`ffmpeg finalizou com código ${code}`));
      }
    });

    ffmpeg.on('error', async (err) => {
      clearTimeout(startTimer);
      console.error('❌ Erro no ffmpeg:', err);
      try {
        await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      } catch (_) {}
      reject(err);
    });
  });
}

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!fs.existsSync(jsonPath)) throw new Error('JSON de entrada não encontrado');

    const data = JSON.parse(fs.readFileSync(jsonPath));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) throw new Error('JSON deve conter id, video_drive_id, stream_url e chave_json');

    const keyFilePath = 'chave_temp.json';
    fs.writeFileSync(keyFilePath, chave_json);

    const videoPrincipal = `${id}.mp4`;
    const logo = 'logo.png';
    const extra1 = 'extra1.mp4', extra2 = 'extra2.mp4', extra3 = 'extra3.mp4';

    // Baixar vídeos e logo
    await baixarArquivo(video_drive_id, videoPrincipal, keyFilePath);
    if (logo_id) await baixarArquivo(logo_id, logo, keyFilePath);
    if (video_extra_1) await baixarArquivo(video_extra_1, extra1, keyFilePath);
    if (video_extra_2) await baixarArquivo(video_extra_2, extra2, keyFilePath);
    if (video_extra_3) await baixarArquivo(video_extra_3, extra3, keyFilePath);

    const duracao = obterDuracaoVideo(videoPrincipal);
    if (duracao <= 0) throw new Error('Vídeo principal inválido');

    // Criar lista concatenação
    const listaConcat = 'videos.txt';
    const videosParaConcat = [
      videoPrincipal,
      ...(video_extra_1 ? [extra1] : []),
      ...(video_extra_2 ? [extra2] : []),
      ...(video_extra_3 ? [extra3] : []),
      videoPrincipal,
    ];
    gerarListaConcat(videosParaConcat, listaConcat);

    // Rodar transmissão única
    await rodarFFmpeg(listaConcat, logo, stream_url, id);

    // Limpeza
    [videoPrincipal, extra1, extra2, extra3, logo, keyFilePath, listaConcat].forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    process.exit(0);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
