const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  console.log(`⬇️ Baixando arquivo ID ${fileId} para ${dest}...`);

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    res.data.pipe(destStream);
    res.data.on('error', reject);
    destStream.on('finish', resolve);
  });
}

function obterDuracaoVideo(filePath) {
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString();
    return parseFloat(output.trim());
  } catch (err) {
    console.error('❌ Erro ao obter duração do vídeo:', err);
    return 0;
  }
}

async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    await page.evaluate(async (payload) => {
      await fetch(window.location.href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }, data);
  } finally {
    await browser.close();
  }
}

function limparArquivos(files) {
  for (const file of files) {
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch (e) {
        console.warn(`⚠️ Erro ao excluir arquivo ${file}:`, e.message);
      }
    }
  }
}

function rodarFFmpegComRotacaoLogo(part1, part2, extras, logo, streamUrl, id) {
  return new Promise((resolve, reject) => {
    // Inputs:
    // 0 - part1 do vídeo principal
    // 1..N - vídeos extras
    // N+1 - part2 do vídeo principal
    // logo último input

    const inputs = [
      '-re', '-i', part1,
      ...extras.flatMap(v => ['-re', '-i', v]),
      '-re', '-i', part2,
      '-re', '-i', logo,
    ];

    const totalVideos = 2 + extras.length;

    let filterConcatInputs = '';
    for (let i = 0; i < totalVideos; i++) {
      filterConcatInputs += `[${i}:v:0][${i}:a:0]`;
    }
    const filterConcat = `${filterConcatInputs}concat=n=${totalVideos}:v=1:a=1[vconcat][aconcat]`;

    // Logo girando 60px largura, no canto superior direito afastado 20px horizontal e vertical
    // Rotação contínua a cada 3 segundos
    const filterLogo = `
      [${totalVideos}:v] scale=60:-1, format=rgba, rotate=2*PI*t/3:ow=rotw(iw):oh=roth(ih):c=none [rlogo];
      [vconcat][rlogo] overlay=W-w-20:20:format=auto
    `.replace(/\s+/g, ' ').trim();

    const filterComplex = `${filterConcat}; ${filterLogo}`;

    const args = [
      ...inputs,
      '-filter_complex', filterComplex,
      '-map', '[vconcat]',
      '-map', '[aconcat]',
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

    console.log('▶️ Executando ffmpeg com os vídeos e logo giratório...');

    const ffmpeg = spawn('ffmpeg', args);

    let notifiedStart = false;
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

    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

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
    if (!jsonPath || !fs.existsSync(jsonPath)) throw new Error('JSON de entrada não encontrado');

    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = data;

    if (!id || !video_drive_id || !stream_url || !chave_json) {
      throw new Error('JSON deve conter id, video_drive_id, stream_url e chave_json');
    }

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, chave_json);

    const videoPrincipalPath = path.join(process.cwd(), `${id}.mp4`);
    const logoPath = path.join(process.cwd(), 'logo.png');
    const videoExtrasPaths = [];
    if (video_extra_1) videoExtrasPaths.push(path.join(process.cwd(), 'extra1.mp4'));
    if (video_extra_2) videoExtrasPaths.push(path.join(process.cwd(), 'extra2.mp4'));
    if (video_extra_3) videoExtrasPaths.push(path.join(process.cwd(), 'extra3.mp4'));

    // Baixar todos arquivos
    await baixarArquivo(video_drive_id, videoPrincipalPath, keyFilePath);
    if (logo_id) {
      await baixarArquivo(logo_id, logoPath, keyFilePath);
    } else {
      console.warn('⚠️ Nenhum logo_id fornecido, logo não será exibido.');
    }
    for (let i = 0; i < videoExtrasPaths.length; i++) {
      await baixarArquivo(data[`video_extra_${i + 1}`], videoExtrasPaths[i], keyFilePath);
    }

    const duracaoTotal = obterDuracaoVideo(videoPrincipalPath);
    if (duracaoTotal <= 0) throw new Error('Duração do vídeo principal inválida');

    const metadeDuracao = duracaoTotal / 2;

    const part1Path = path.join(process.cwd(), 'part1.mp4');
    const part2Path = path.join(process.cwd(), 'part2.mp4');

    // Extrair partes do vídeo principal (sem reencode)
    execSync(`ffmpeg -y -i "${videoPrincipalPath}" -t ${metadeDuracao} -c copy "${part1Path}"`);
    execSync(`ffmpeg -y -ss ${metadeDuracao} -i "${videoPrincipalPath}" -c copy "${part2Path}"`);

    // Executar ffmpeg único que concatena as partes e extras com logo giratório
    await rodarFFmpegComRotacaoLogo(part1Path, part2Path, videoExtrasPaths, logoPath, stream_url, id);

    limparArquivos([
      videoPrincipalPath,
      logoPath,
      ...videoExtrasPaths,
      keyFilePath,
      part1Path,
      part2Path,
    ]);

    console.log('🏁 Transmissão concluída e arquivos limpos.');
    process.exit(0);
  } catch (err) {
    console.error('💥 Erro fatal:', err);
    process.exit(1);
  }
}

main();
