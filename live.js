const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
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

async function criarArquivoListaConcat(videos, listaPath) {
  const conteudo = videos.map(f => `file '${f}'`).join('\n');
  fs.writeFileSync(listaPath, conteudo);
}

async function unirVideos(listaConcat, output) {
  try {
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listaConcat}" -c copy "${output}"`);
  } catch (e) {
    throw new Error('Erro ao unir vídeos: ' + e.message);
  }
}

async function adicionarLogoRotativo(videoInput, logoPath, output) {
  // O logo será redimensionado (escala) e girado (rotate) continuamente a cada 3s.
  const filtroLogo = `[1:v]format=rgba,scale=iw/8:-1,rotate=2*PI*t/3:c=none:ow=rotw(iw):oh=roth(ih)[logo];
    [0:v][logo]overlay=W-w-10:10:shortest=1`;

  const cmd = `ffmpeg -y -i "${videoInput}" -i "${logoPath}" -filter_complex "${filtroLogo}" -c:a copy -c:v libx264 -preset veryfast -crf 23 "${output}"`;
  try {
    await execPromise(cmd);
  } catch (e) {
    throw new Error('Erro ao adicionar logo: ' + e.message);
  }
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

    // Salva chave temporária
    const keyPath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyPath, chave_json);

    // Baixa vídeo principal
    const mainVideo = `${id}.mp4`;
    console.log(`📥 Baixando vídeo principal (${video_drive_id})`);
    await baixarArquivo(video_drive_id, mainVideo, keyPath);

    // Baixa vídeos extras
    const extras = [];
    for (const [i, extraId] of [video_extra_1, video_extra_2, video_extra_3].entries()) {
      if (extraId) {
        const extraName = `extra${i+1}.mp4`;
        console.log(`📥 Baixando vídeo extra: ${extraName}`);
        await baixarArquivo(extraId, extraName, keyPath);
        extras.push(extraName);
      }
    }

    // Cria lista de concatenação: vídeo principal + extras
    const listaVideos = [mainVideo, ...extras];
    const listaPath = 'lista.txt';
    await criarArquivoListaConcat(listaVideos, listaPath);

    // Une vídeos em um só
    const videoUnido = 'video_unido.mp4';
    console.log('🔗 Unindo vídeos...');
    await unirVideos(listaPath, videoUnido);

    // Baixa logo e adiciona ao vídeo unido, se tiver logo
    let videoFinal = videoUnido;
    if (logo_id) {
      const logoPath = 'logo.png';
      console.log('🖼️ Baixando logo');
      await baixarArquivo(logo_id, logoPath, keyPath);
      const videoComLogo = 'video_com_logo.mp4';
      console.log('✨ Adicionando logo giratório...');
      await adicionarLogoRotativo(videoUnido, logoPath, videoComLogo);
      videoFinal = videoComLogo;
    }

    // Mostra tamanho do vídeo final
    const stats = fs.statSync(videoFinal);
    const tamanhoMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`📁 Vídeo final pronto: ${videoFinal} (${tamanhoMB} MB)`);

    // Só inicia a transmissão se o arquivo final existe e tem tamanho válido
    if (tamanhoMB > 1) {
      console.log('▶️ Iniciando transmissão com vídeo final...');
      await transmitirVideo(videoFinal, stream_url, id);
    } else {
      throw new Error('Vídeo final muito pequeno ou não criado corretamente');
    }

    fs.unlinkSync(keyPath);

  } catch (e) {
    console.error('💥 Erro fatal:', e.message);
    process.exit(1);
  }
}

main();
