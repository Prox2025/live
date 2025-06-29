const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

function execPromise(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, { shell: true });
    proc.stdout.on('data', data => process.stdout.write(data));
    proc.stderr.on('data', data => process.stderr.write(data));
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`Erro: ${command}`))));
  });
}

async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarVideo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando ${fileId} → ${dest}`);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    res.data.pipe(destStream);
    destStream.on('finish', () => {
      console.log(`✅ Salvo ${dest}`);
      resolve();
    });
    destStream.on('error', err => reject(err));
  });
}

function obterDuracao(videoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath
    ]);
    let output = '';
    proc.stdout.on('data', data => output += data);
    proc.stderr.on('data', data => process.stderr.write(data));
    proc.on('close', () => {
      const dur = parseFloat(output);
      isNaN(dur) ? reject('❌ Duração inválida') : resolve(dur);
    });
  });
}

async function dividirVideo(input, meio) {
  await execPromise(`ffmpeg -y -i ${input} -t ${meio} -c copy parte1.mp4`);
  await execPromise(`ffmpeg -y -i ${input} -ss ${meio} -c copy parte2.mp4`);
}

function criarListaConcat(videos, fileName = 'lista.txt') {
  const linhas = videos.map(v => `file '${v}'`).join('\n');
  fs.writeFileSync(fileName, linhas);
}

async function unirVideosComLogo(listaPath, logoPath, output) {
  const filtroLogo = `[1:v]format=rgba,scale=iw/8:-1,rotate=PI/60*t:c=none:ow=rotw(iw):oh=roth(ih)[logo];
    [0:v][logo]overlay=W-w-10:10:shortest=1`;
  const comando = `ffmpeg -y -f concat -safe 0 -i ${listaPath} -i ${logoPath} -filter_complex "${filtroLogo}" -preset veryfast -crf 23 -c:a copy ${output}`;
  await execPromise(comando);
}

async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 2000));
    const resposta = await page.evaluate(async (payload) => {
      const res = await fetch(window.location.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { status: res.status, texto: await res.text() };
    }, data);
    await browser.close();
    return resposta;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function rodarFFmpeg(inputFile, streamUrl) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-re', '-i', inputFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-maxrate', '3500k', '-bufsize', '7000k',
      '-pix_fmt', 'yuv420p', '-g', '50',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
      '-f', 'flv', streamUrl
    ]);

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    let notified = false;
    const timer = setTimeout(async () => {
      if (!notified) {
        const id = path.basename(inputFile, '.mp4');
        await enviarStatusPuppeteer({ id, status: 'started' });
        notified = true;
      }
    }, 60000);

    ffmpeg.on('close', async (code) => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      const status = code === 0 ? 'finished' : 'error';
      await enviarStatusPuppeteer({ id, status });
      resolve();
    });

    ffmpeg.on('error', async err => {
      clearTimeout(timer);
      const id = path.basename(inputFile, '.mp4');
      await enviarStatusPuppeteer({ id, status: 'error', message: err.message });
      reject(err);
    });
  });
}

async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) throw new Error('input.json não encontrado');
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

    const {
      id, video_drive_id, stream_url, chave_json,
      logo_id, video_extra_1, video_extra_2, video_extra_3
    } = data;

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, typeof chave_json === 'string' ? chave_json : JSON.stringify(chave_json));

    const arquivos = [];

    await baixarVideo(video_drive_id, 'video_principal.mp4', keyFilePath);
    arquivos.push('video_principal.mp4');

    if (video_extra_1) await baixarVideo(video_extra_1, 'extra_1.mp4', keyFilePath);
    if (video_extra_2) await baixarVideo(video_extra_2, 'extra_2.mp4', keyFilePath);
    if (video_extra_3) await baixarVideo(video_extra_3, 'extra_3.mp4', keyFilePath);
    if (logo_id) await baixarVideo(logo_id, 'logo.png', keyFilePath);

    const duracao = await obterDuracao('video_principal.mp4');
    const meio = duracao / 2;

    await dividirVideo('video_principal.mp4', meio);

    const listaConcat = ['parte1.mp4'];
    if (video_extra_1) listaConcat.push('extra_1.mp4');
    if (video_extra_2) listaConcat.push('extra_2.mp4');
    if (video_extra_3) listaConcat.push('extra_3.mp4');
    listaConcat.push('parte2.mp4');

    criarListaConcat(listaConcat, 'lista.txt');

    await unirVideosComLogo('lista.txt', 'logo.png', 'final.mp4');

    const finalSize = fs.statSync('final.mp4').size;
    console.log(`📦 Tamanho final: ${(finalSize / 1024 / 1024).toFixed(2)} MB`);

    await rodarFFmpeg('final.mp4', stream_url);

    // Limpeza
    const arquivosTmp = ['video_principal.mp4', 'parte1.mp4', 'parte2.mp4', 'final.mp4', 'lista.txt', 'logo.png', 'extra_1.mp4', 'extra_2.mp4', 'extra_3.mp4', 'chave_temp.json'];
    arquivosTmp.forEach(f => fs.existsSync(f) && fs.unlinkSync(f));

  } catch (err) {
    console.error('💥 Erro fatal:', err.message);
    process.exit(1);
  }
}

main();
