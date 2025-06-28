const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

// Helper para autenticar Google API
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  return await auth.getClient();
}

// Download arquivo do Drive
async function baixarArquivo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando arquivo ID ${fileId} para ${dest}...`);

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

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
      console.error('❌ Erro ao salvar arquivo:', err);
      reject(err);
    });
  });
}

// Obtém duração do vídeo (segundos) usando ffprobe
function obterDuracaoVideo(filePath) {
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString();
    return parseFloat(output.trim());
  } catch (err) {
    console.error('❌ Erro ao obter duração do vídeo:', err);
    return 0;
  }
}

// Envia status para servidor via Puppeteer (igual antes)
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
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
        return { status: 500, texto: 'Erro interno no fetch: ' + e.message };
      }
    }, data);

    await browser.close();
    return resposta;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

// Função para rodar ffmpeg com overlay de logo e duração máxima
function rodarFFmpegComLogo(videoFile, logoFile, streamUrl, duracaoMaxSeg) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Iniciando transmissão do vídeo principal com logo por até ${duracaoMaxSeg.toFixed(2)} segundos`);

    const args = [
      '-re',
      '-i', videoFile,
      '-i', logoFile,
      '-filter_complex',
      `[1:v] scale=150:-1 [logo]; [0:v][logo] overlay=W-w-10:10,scale=1280:720`,
      '-t', duracaoMaxSeg.toString(),
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

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('✅ Vídeo principal com logo finalizado.');
        resolve();
      } else {
        reject(new Error(`ffmpeg (vídeo principal) finalizou com código ${code}`));
      }
    });

    ffmpeg.on('error', err => {
      reject(err);
    });
  });
}

// Função para rodar vídeos extras (sem logo)
function rodarVideoExtra(videoFile, streamUrl) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Transmitindo vídeo extra: ${videoFile}`);

    const args = [
      '-re',
      '-i', videoFile,
      '-vf', 'scale=1280:720',
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

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    ffmpeg.on('close', code => {
      if (code === 0) {
        console.log('✅ Vídeo extra finalizado.');
        resolve();
      } else {
        reject(new Error(`ffmpeg (vídeo extra) finalizou com código ${code}`));
      }
    });

    ffmpeg.on('error', err => reject(err));
  });
}

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      throw new Error(`JSON de entrada não encontrado: ${jsonPath}`);
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) {
      throw new Error('JSON deve conter id, video_drive_id, stream_url e chave_json');
    }

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, chave_json);

    // Paths locais dos vídeos e logo
    const videoPrincipalPath = path.join(process.cwd(), `${id}.mp4`);
    const logoPath = path.join(process.cwd(), 'logo.png');
    const videosExtrasPaths = [
      video_extra_1 ? path.join(process.cwd(), `extra1.mp4`) : null,
      video_extra_2 ? path.join(process.cwd(), `extra2.mp4`) : null,
      video_extra_3 ? path.join(process.cwd(), `extra3.mp4`) : null,
    ].filter(Boolean);

    // Baixar vídeo principal e logo
    await baixarArquivo(video_drive_id, videoPrincipalPath, keyFilePath);
    if (logo_id) {
      await baixarArquivo(logo_id, logoPath, keyFilePath);
    } else {
      console.warn('⚠️ Nenhum logo_id fornecido, logo não será exibido.');
    }

    // Baixar vídeos extras
    if (video_extra_1) await baixarArquivo(video_extra_1, videosExtrasPaths[0], keyFilePath);
    if (video_extra_2) await baixarArquivo(video_extra_2, videosExtrasPaths[1], keyFilePath);
    if (video_extra_3) await baixarArquivo(video_extra_3, videosExtrasPaths[2], keyFilePath);

    // Obter duração total do vídeo principal
    const duracaoTotal = obterDuracaoVideo(videoPrincipalPath);
    if (duracaoTotal <= 0) throw new Error('Duração do vídeo principal inválida');

    // Definir metade da duração
    const duracaoMetade = duracaoTotal / 2;

    // Notificar que a live vai começar
    await enviarStatusPuppeteer({ id, status: 'started' });

    // 1) Rodar vídeo principal com logo pela metade da duração
    await rodarFFmpegComLogo(videoPrincipalPath, logoPath, stream_url, duracaoMetade);

    // 2) Rodar vídeos extras sequencialmente (sem logo)
    for (const videoExtraPath of videosExtrasPaths) {
      await rodarVideoExtra(videoExtraPath, stream_url);
    }

    // 3) Rodar vídeo principal novamente com logo pela metade restante
    const duracaoRestante = duracaoTotal - duracaoMetade;
    if (duracaoRestante > 0) {
      await rodarFFmpegComLogo(videoPrincipalPath, logoPath, stream_url, duracaoRestante);
    }

    // Notificar fim da live
    await enviarStatusPuppeteer({ id, status: 'finished' });

    // Limpar arquivos
    fs.unlinkSync(videoPrincipalPath);
    if (fs.existsSync(logoPath)) fs.unlinkSync(logoPath);
    videosExtrasPaths.forEach(p => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    fs.unlinkSync(keyFilePath);

    console.log('🏁 Transmissão concluída com sucesso');
    process.exit(0);

  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
