const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

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

  console.log(`⬇️ Baixando arquivo ${fileId} para ${dest}...`);
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

async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.waitForTimeout(3000);

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
    await browser.close();
    return resposta;
  } catch (err) {
    console.error("❌ Erro ao enviar status:", err.message);
    await browser.close();
    throw err;
  }
}

function cortarVideo(input, output1, output2, meio) {
  return Promise.all([
    new Promise((resolve, reject) => {
      ffmpeg(input).setStartTime(0).setDuration(meio)
        .output(output1).on('end', () => {
          console.log(`✂️ Corte concluído: ${output1}`); resolve();
        }).on('error', reject).run();
    }),
    new Promise((resolve, reject) => {
      ffmpeg(input).setStartTime(meio)
        .output(output2).on('end', () => {
          console.log(`✂️ Corte concluído: ${output2}`); resolve();
        }).on('error', reject).run();
    })
  ]);
}

function obterDuracaoVideo(input) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(input, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration);
    });
  });
}

function concatenarVideos(videos, output) {
  return new Promise((resolve, reject) => {
    const txtList = 'concat_list.txt';
    const listContent = videos.map(f => `file '${path.resolve(f)}'`).join('\n');
    fs.writeFileSync(txtList, listContent);

    ffmpeg()
      .input(txtList)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .output(output)
      .on('end', () => {
        console.log(`🔗 Vídeos concatenados com sucesso em ${output}`);
        fs.unlinkSync(txtList);
        resolve();
      })
      .on('error', (err) => {
        fs.unlinkSync(txtList);
        reject(err);
      })
      .run();
  });
}

function rodarFFmpegComLogo(input, logo, streamUrl) {
  return new Promise((resolve, reject) => {
    const id = path.basename(input, '.mp4');

    const ffmpegArgs = [
      '-re', '-i', input,
      '-i', logo,
      '-filter_complex',
      "[1:v]format=rgba,rotate=PI/1.5:enable='lt(mod(t\\,3)\\,1)',scale=100:100[logo];" +
      "[0:v][logo]overlay=W-w-10:10",
      '-s', '720x1280',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
      '-f', 'flv', streamUrl
    ];

    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

    let notifiedStart = false;
    const timer = setTimeout(async () => {
      if (!notifiedStart) {
        console.log('🔔 Notificando início da live...');
        try {
          await enviarStatusPuppeteer({ id, status: 'started' });
          notifiedStart = true;
        } catch (e) {
          console.error('⚠️ Falha ao notificar início:', e);
        }
      }
    }, 60000);

    ffmpegProc.stdout.on('data', data => process.stdout.write(data));
    ffmpegProc.stderr.on('data', data => process.stderr.write(data));

    ffmpegProc.on('close', async (code) => {
      clearTimeout(timer);
      if (code === 0) {
        console.log('✅ Live finalizada com sucesso.');
        await enviarStatusPuppeteer({ id, status: 'finished' });
        resolve();
      } else {
        console.error('❌ ffmpeg terminou com erro:', code);
        await enviarStatusPuppeteer({ id, status: 'error', code });
        reject(new Error('ffmpeg falhou'));
      }
    });

    ffmpegProc.on('error', async (err) => {
      clearTimeout(timer);
      await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      reject(err);
    });
  });
}

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) {
      console.error('❌ JSON de entrada não encontrado:', jsonPath);
      process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, JSON.stringify(chave_json)); // ✅ CORRIGIDO

    const base = process.cwd();
    const videoPrincipal = path.join(base, `${id}_principal.mp4`);
    await baixarArquivo(video_drive_id, videoPrincipal, keyFilePath);

    const duracao = await obterDuracaoVideo(videoPrincipal);
    const meio = duracao / 2;
    console.log(`⏱ Duração do vídeo principal: ${duracao.toFixed(2)}s`);

    const parte1 = path.join(base, `${id}_parte1.mp4`);
    const parte2 = path.join(base, `${id}_parte2.mp4`);
    await cortarVideo(videoPrincipal, parte1, parte2, meio);

    const extras = [];
    if (video_extra_1) {
      const f = path.join(base, `${id}_extra_1.mp4`);
      await baixarArquivo(video_extra_1, f, keyFilePath);
      extras.push(f);
    }
    if (video_extra_2) {
      const f = path.join(base, `${id}_extra_2.mp4`);
      await baixarArquivo(video_extra_2, f, keyFilePath);
      extras.push(f);
    }
    if (video_extra_3) {
      const f = path.join(base, `${id}_extra_3.mp4`);
      await baixarArquivo(video_extra_3, f, keyFilePath);
      extras.push(f);
    }

    const logoPath = logo_id ? path.join(base, `${id}_logo.png`) : null;
    if (logo_id) await baixarArquivo(logo_id, logoPath, keyFilePath);

    const finalVideo = path.join(base, `${id}_concat.mp4`);
    const todos = [parte1, ...extras, parte2];
    await concatenarVideos(todos, finalVideo);

    await rodarFFmpegComLogo(finalVideo, logoPath, stream_url);

    [videoPrincipal, parte1, parte2, finalVideo, ...extras].forEach(f => {
      try { fs.unlinkSync(f); } catch (_) {}
    });

    fs.unlinkSync(keyFilePath);
  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
