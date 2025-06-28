const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { google } = require('googleapis');
const puppeteer = require('puppeteer');

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const SERVER_STATUS_URL = 'https://livestream.ct.ws/Google%20drive/live/status.php';

// AutenticaÃ§Ã£o
async function autenticar(keyFilePath) {
  const auth = new google.auth.GoogleAuth({ keyFile: keyFilePath, scopes: SCOPES });
  return await auth.getClient();
}

// Baixar arquivo
async function baixarArquivo(fileId, dest, keyFilePath) {
  const auth = await autenticar(keyFilePath);
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const destStream = fs.createWriteStream(dest);
    res.data.pipe(destStream);
    res.data.on('error', reject);
    destStream.on('finish', resolve);
    destStream.on('error', reject);
  });
}

// DuraÃ§Ã£o do vÃ­deo
function obterDuracao(filePath) {
  try {
    const output = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString();
    return parseFloat(output.trim());
  } catch {
    return 0;
  }
}

// Enviar status via Puppeteer
async function enviarStatusPuppeteer(data) {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.emulateTimezone('Africa/Maputo');
    await page.goto(SERVER_STATUS_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(res => setTimeout(res, 3000));
    const response = await page.evaluate(async (payload) => {
      try {
        const res = await fetch(window.location.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        return { status: res.status, texto: await res.text() };
      } catch (e) {
        return { status: 500, texto: 'Erro interno: ' + e.message };
      }
    }, data);
    await browser.close();
    return response;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// Executar live
async function main() {
  try {
    const jsonPath = process.argv[2];
    if (!jsonPath || !fs.existsSync(jsonPath)) throw new Error("input.json nÃ£o encontrado");

    const { id, video_drive_id, stream_url, chave_json, logo_id, video_extra_1, video_extra_2, video_extra_3 } = JSON.parse(fs.readFileSync(jsonPath));

    const keyFilePath = path.join(process.cwd(), 'chave_temp.json');
    fs.writeFileSync(keyFilePath, chave_json);

    const videoPath = path.join(process.cwd(), `${id}.mp4`);
    const logoPath = path.join(process.cwd(), 'logo.png');
    const part1 = path.join(process.cwd(), 'part1.mp4');
    const part2 = path.join(process.cwd(), 'part2.mp4');
    const concatList = path.join(process.cwd(), 'concat_list.txt');

    const extras = [];
    if (video_extra_1) extras.push(['extra1.mp4', video_extra_1]);
    if (video_extra_2) extras.push(['extra2.mp4', video_extra_2]);
    if (video_extra_3) extras.push(['extra3.mp4', video_extra_3]);

    // Baixar principal e logo
    await baixarArquivo(video_drive_id, videoPath, keyFilePath);
    if (logo_id) await baixarArquivo(logo_id, logoPath, keyFilePath);

    for (const [filename, driveId] of extras) {
      await baixarArquivo(driveId, path.join(process.cwd(), filename), keyFilePath);
    }

    const duracao = obterDuracao(videoPath);
    if (!duracao) throw new Error("Erro na duraÃ§Ã£o do vÃ­deo");

    const metade = duracao / 2;
    execSync(`ffmpeg -y -i "${videoPath}" -t ${metade} -vf "scale=1280:720" part1.mp4`);
    execSync(`ffmpeg -y -i "${videoPath}" -ss ${metade} -vf "scale=1280:720" part2.mp4`);

    for (const [filename] of extras) {
      execSync(`ffmpeg -y -i "${filename}" -vf "scale=1280:720" "${filename}"`);
    }

    const list = ['part1.mp4', ...extras.map(([f]) => f), 'part2.mp4']
      .map(f => `file '${f}'`)
      .join('\n');
    fs.writeFileSync(concatList, list);

    // Notifica inÃ­cio
    await enviarStatusPuppeteer({ id, status: 'started' });

    const overlayFilter = "[1]format=rgba,rotate=PI/1.5*t:enable='mod(t\,3)',scale=80:-1[logo];[0][logo]overlay=W-w-20:20";

    const args = [
      '-f', 'concat', '-safe', '0', '-i', 'concat_list.txt',
      '-stream_loop', '-1', '-i', 'logo.png',
      '-filter_complex', overlayFilter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-ar', '44100',
      '-f', 'flv', stream_url
    ];

    const ffmpeg = spawn('ffmpeg', args);
    ffmpeg.stdout.on('data', data => process.stdout.write(data));
    ffmpeg.stderr.on('data', data => process.stderr.write(data));

    ffmpeg.on('close', async code => {
      if (code === 0) {
        console.log("âœ… Live finalizada");
        await enviarStatusPuppeteer({ id, status: 'finished' });
      } else {
        console.error("âŒ ffmpeg falhou:", code);
        await enviarStatusPuppeteer({ id, status: 'error', message: 'ffmpeg falhou: ' + code });
      }

      [videoPath, part1, part2, concatList, keyFilePath, logoPath, ...extras.map(([f]) => path.join(process.cwd(), f))]
        .forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

      process.exit(code === 0 ? 0 : 1);
    });

  } catch (err) {
    console.error("ðŸ’¥ Erro:", err.message);
    process.exit(1);
  }
}

main();
