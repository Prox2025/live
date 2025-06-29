const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');
const util = require('util');

const execPromise = util.promisify(exec);
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  return await auth.getClient();
}

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

async function obterDuracao(videoPath) {
  const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`);
  return parseFloat(stdout.trim());
}

async function dividirVideo(videoPath, duracao) {
  const metade = duracao / 2;
  await execPromise(`ffmpeg -y -i "${videoPath}" -t ${metade} -c copy parte1.mp4`);
  await execPromise(`ffmpeg -y -i "${videoPath}" -ss ${metade} -c copy parte2.mp4`);
}

function criarListaConcat(videos, listaPath) {
  const conteudo = videos.map(v => `file '${v}'`).join('\n');
  fs.writeFileSync(listaPath, conteudo);
}

async function unirVideosComLogo(listaPath, logoPath, output) {
  const filtroLogo = `[1:v]format=rgba,scale=iw/8:-1,rotate=PI/60*t:c=none:ow=rotw(iw):oh=roth(ih)[logo];
    [0:v][logo]overlay=W-w-10:10:shortest=1`;
  const comando = `ffmpeg -y -f concat -safe 0 -i ${listaPath} -i ${logoPath} \
-filter_complex "${filtroLogo}" \
-c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
-c:a aac -b:a 192k -ar 44100 -movflags +faststart \
${output}`;
  await execPromise(comando);
}

async function enviarStatus(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
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
        return { status: 500, texto: e.message };
      }
    }, data);
    await browser.close();
    return resposta;
  } catch (err) {
    await browser.close();
    throw err;
  }
}

async function transmitirVideo(videoPath, streamUrl, id) {
  console.log('📡 Iniciando transmissão...');
  const ffmpeg = spawn('ffmpeg', [
    '-re', '-i', videoPath,
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-crf', '18', '-maxrate', '3500k', '-bufsize', '7000k',
    '-pix_fmt', 'yuv420p', '-g', '50',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100',
    '-f', 'flv', streamUrl
  ]);

  let notificado = false;
  const timer = setTimeout(async () => {
    if (!notificado) {
      await enviarStatus({ id, status: 'started' });
      console.log('✅ Live iniciada');
      notificado = true;
    }
  }, 60000);

  ffmpeg.stderr.on('data', data => process.stderr.write(data));
  ffmpeg.on('close', async code => {
    clearTimeout(timer);
    await enviarStatus({ id, status: code === 0 ? 'finished' : 'error' });
    console.log(code === 0 ? '✅ Live encerrada' : `❌ ffmpeg falhou (${code})`);
  });
}

async function main() {
  try {
    const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = input;
    const keyPath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyPath, chave_json);

    console.log(`📥 Baixando vídeo principal (${video_drive_id})`);
    await baixarArquivo(video_drive_id, `${id}.mp4`, keyPath);

    const extras = [];
    for (const [i, extraId] of [video_extra_1, video_extra_2, video_extra_3].entries()) {
      if (extraId) {
        const name = `extra${i + 1}.mp4`;
        console.log(`📥 Baixando vídeo extra: ${name}`);
        await baixarArquivo(extraId, name, keyPath);
        extras.push(name);
      }
    }

    let logoPath = 'logo.png';
    if (logo_id) {
      console.log('🖼️ Baixando logo');
      await baixarArquivo(logo_id, logoPath, keyPath);
    }

    console.log('⏱️ Obtendo duração do vídeo...');
    const duracao = await obterDuracao(`${id}.mp4`);
    console.log(`⏳ Duração total: ${duracao.toFixed(2)} segundos`);

    console.log('✂️ Dividindo vídeo principal');
    await dividirVideo(`${id}.mp4`, duracao);

    const lista = ['parte1.mp4', ...extras, 'parte2.mp4'];
    criarListaConcat(lista, 'lista.txt');

    console.log('🎞️ Unindo vídeos e aplicando logo');
    await unirVideosComLogo('lista.txt', logoPath, 'final.mp4');

    const stats = fs.statSync('final.mp4');
    const tamanhoMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📁 Vídeo final criado: ${tamanhoMB} MB`);

    console.log('📡 Pronto para transmissão');
    await transmitirVideo('final.mp4', stream_url, id);

    fs.unlinkSync(keyPath);
  } catch (e) {
    console.error('💥 Erro:', e.message);
    process.exit(1);
  }
}

main();
