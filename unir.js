const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Executando FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) {
        console.log(`✅ FFmpeg finalizado com sucesso.`);
        resolve();
      } else {
        reject(new Error(`FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function autenticar() {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(fileId, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => resolve());
    res.data.on('error', err => reject(err));
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error('ffprobe falhou'));
    });
  });
}

async function cortarVideo(input, out1, out2, meio) {
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
}

async function gerarImagemTexto(texto) {
  fs.writeFileSync('descricao.txt', texto);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x00000000:s=600x80',
    '-vf', `drawtext=textfile=descricao.txt:fontcolor=white:fontsize=24:x=10:y=10`,
    '-frames:v', '1',
    'texto.png'
  ]);
}

async function aplicarRodapeELogo(input, output, rodape, logo, delaySec = 360) {
  const filter = `[0:v]format=rgba[base];` +
    `[1:v]scale=iw*0.15:-1[logo_scaled];` +
    `[2:v][3:v]hstack=inputs=2[rodape_completo];` +
    `[rodape_completo]format=rgba,colorchannelmixer=aa='if(lt(t,${delaySec}),0,if(lt(t,${delaySec + 5}),(t-${delaySec})/5,if(lt(t,${delaySec + 30}),1,if(lt(t,${delaySec + 35}),(${delaySec + 35}-t)/5,0))))'[footer_alpha];` +
    `[base][footer_alpha]overlay=x=0:y=main_h-overlay_h:format=auto[tmp1];` +
    `[tmp1][logo_scaled]overlay=W-w-10:10:format=auto`;

  await executarFFmpeg([
    '-i', input,
    '-i', logo,
    '-i', rodape,
    '-i', 'texto.png',
    '-filter_complex', filter,
    '-c:a', 'copy',
    output
  ]);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
}

(async () => {
  try {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const {
      id,
      stream_url,
      video_principal,
      video_inicial,
      video_miraplay,
      video_final,
      logo_id,
      rodape_base64,
      rodape_texto,
      videos_extras = []
    } = dados;

    if (rodape_base64) {
      const base64 = rodape_base64.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync('footer.png', base64, 'base64');
    }

    if (rodape_texto) await gerarImagemTexto(rodape_texto);
    if (logo_id) await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    await aplicarRodapeELogo('parte1_re.mp4', 'parte1_final.mp4', 'footer.png', 'logo.png', 360);
    await aplicarRodapeELogo('parte2_re.mp4', 'parte2_final.mp4', 'footer.png', 'logo.png', 360);

    const arquivos = ['parte1_final.mp4'];

    const ids = [
      video_inicial,
      video_miraplay,
      ...videos_extras.slice(0, 2),
      video_inicial,
      'parte2_final.mp4',
      video_final
    ];

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!id) continue;
      const raw = `v${i}_raw.mp4`;
      const out = `v${i}.mp4`;
      await baixarArquivo(id, raw, auth);
      await reencode(raw, out);
      arquivos.push(out);
    }

    await unirVideos(arquivos, 'video_final_completo.mp4');

    fs.writeFileSync('stream_info.json', JSON.stringify({
      stream_url,
      video_id: id
    }, null, 2));

    console.log('🎉 Concluído. Vídeo final: video_final_completo.mp4');
  } catch (err) {
    console.error('❌ Erro geral:', err);
    process.exit(1);
  }
})();
