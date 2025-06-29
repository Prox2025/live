const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const { getVideoDurationInSeconds } = require('get-video-duration');
const ffmpeg = require('fluent-ffmpeg');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google drive/live/status.php';

// === Autenticação Google Drive ===
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({
    keyFile: keyFilePath,
    scopes: SCOPES,
  });
  return await auth.getClient();
}

async function baixarArquivo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando ${fileId} → ${dest}`);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    res.data.pipe(destStream);
    res.data.on('end', () => {
      console.log(`✅ Arquivo salvo: ${dest}`);
      resolve();
    });
    res.data.on('error', reject);
  });
}

async function dividirVideoEmDuasPartes(inputPath, parte1, parte2) {
  const duracao = await getVideoDurationInSeconds(inputPath);
  const meio = duracao / 2;

  return new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const cmd1 = `ffmpeg -y -i "${inputPath}" -t ${meio} -c copy "${parte1}"`;
    const cmd2 = `ffmpeg -y -i "${inputPath}" -ss ${meio} -c copy "${parte2}"`;

    exec(cmd1, (err) => {
      if (err) return reject(err);
      exec(cmd2, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

async function montarVideoFinal(comPartes, logoPath, saidaFinal) {
  const listaTxt = 'lista.txt';
  fs.writeFileSync(listaTxt, comPartes.map(v => `file '${v}'`).join('\n'));

  const videoCombinado = 'combinado.mp4';

  // Concatena vídeos
  await new Promise((resolve, reject) => {
    const { exec } = require('child_process');
    const cmd = `ffmpeg -y -f concat -safe 0 -i "${listaTxt}" -c copy "${videoCombinado}"`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      fs.unlinkSync(listaTxt);
      resolve();
    });
  });

  // Sobrepõe logo com rotação
  return new Promise((resolve, reject) => {
    ffmpeg(videoCombinado)
      .input(logoPath)
      .complexFilter([
        {
          filter: 'overlay',
          options: {
            x: '(main_w-overlay_w)-10',
            y: '10',
            enable: 'lt(mod(t,6),3)' // gira a cada 3 segundos (3 on, 3 off)
          }
        }
      ])
      .videoCodec('libx264')
      .audioCodec('aac')
      .size('1280x720')
      .outputOptions(['-preset veryfast', '-crf 23'])
      .output(saidaFinal)
      .on('end', () => {
        try { fs.unlinkSync(videoCombinado); } catch (_) {}
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// === Notificação do status via Puppeteer ===
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
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

    console.log("📡 Resposta:", resposta);
    await browser.close();
    return resposta;
  } catch (err) {
    console.error("❌ Erro ao enviar status:", err.message);
    await browser.close();
    throw err;
  }
}

async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpegProcess = spawn('ffmpeg', [
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

    ffmpegProcess.stdout.on('data', data => process.stdout.write(data));
    ffmpegProcess.stderr.on('data', data => process.stderr.write(data));

    let notified = false;
    const timer = setTimeout(async () => {
      if (!notified) {
        notified = true;
        const id = path.basename(inputFile, '.mp4');
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
        } catch (e) { console.error('⚠️ Erro ao notificar início:', e); }
      }
    }, 60000);

    ffmpegProcess.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');

      if (code === 0) {
        console.log('✅ Live finalizada');
        await enviarStatusPuppeteer({ id, status: 'finished' });
        try { fs.unlinkSync(inputFile); } catch (_) {}
        resolve();
      } else {
        console.error(`❌ ffmpeg saiu com código ${code}`);
        await enviarStatusPuppeteer({ id, status: 'error', message: `ffmpeg code ${code}` });
        reject(new Error(`ffmpeg code ${code}`));
      }
    });

    ffmpegProcess.on('error', async (err) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      reject(err);
    });
  });
}

// === Função principal ===
async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('❌ JSON de entrada não encontrado:', jsonPath);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) {
      throw new Error('Faltando dados obrigatórios');
    }

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, chave_json);

    const videoFile = `${id}.mp4`;
    await baixarArquivo(video_drive_id, videoFile, keyFilePath);

    // Baixar vídeos extras
    const extraIds = [video_extra_1, video_extra_2, video_extra_3].filter(Boolean);
    const extras = [];
    for (let i = 0; i < extraIds.length; i++) {
      const nome = `extra${i + 1}.mp4`;
      await baixarArquivo(extraIds[i], nome, keyFilePath);
      extras.push(nome);
    }

    // Baixar logo
    const logoPath = 'logo.png';
    if (logo_id) {
      await baixarArquivo(logo_id, logoPath, keyFilePath);
    }

    // Dividir vídeo principal
    const parte1 = 'parte1.mp4', parte2 = 'parte2.mp4';
    await dividirVideoEmDuasPartes(videoFile, parte1, parte2);

    // Unir tudo com logo
    const saidaFinal = `final_${id}.mp4`;
    await montarVideoFinal([parte1, ...extras, parte2], logoPath, saidaFinal);

    // Limpar temporários
    [videoFile, ...extras, parte1, parte2, logoPath].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });

    // Transmitir
    await rodarFFmpeg(saidaFinal, stream_url);
    fs.unlinkSync(saidaFinal);
    fs.unlinkSync(keyFilePath);

  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
