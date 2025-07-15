const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const keyFile = path.join(os.homedir(), '.config', 'rclone', 'rclone.conf');
const inputFile = process.env.INPUTFILE || 'input.json';
const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function executarFFmpeg(args, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stderr.on('data', data => process.stderr.write(data));
    ffmpeg.on('close', code => {
      if (code === 0) {
        if (output) console.log(`✅ Criado: ${output}`);
        resolve();
      } else {
        reject(new Error(`❌ FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '23',
    '-c:a', 'aac',
    '-ar', '44100',
    output
  ], output);
  registrarTemporario(output);
}

async function baixarArquivo(caminhoRclone, destino) {
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', [
      'copy', `meudrive:${caminhoRclone}`, '.',
      '--config', keyFile
    ]);
    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', async code => {
      if (code === 0) {
        const nomeArquivo = path.basename(caminhoRclone);
        if (!fs.existsSync(nomeArquivo)) {
          return reject(new Error(`❌ Arquivo não encontrado: ${nomeArquivo}`));
        }
        fs.renameSync(nomeArquivo, destino);
        registrarTemporario(destino);
        await reencode(destino, destino);
        console.log(`📥 Baixado e codificado: ${destino}`);
        resolve();
      } else {
        reject(new Error(`❌ Falha no rclone para ${caminhoRclone}`));
      }
    });
  });
}

async function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => resolve(parseFloat(data.trim())));
    ffprobe.on('error', reject);
  });
}

async function cortarTrecho(input, inicio, duracao, output) {
  await executarFFmpeg([
    '-i', input,
    '-ss', inicio.toString(),
    '-t', duracao.toString(),
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-ar', '44100',
    output
  ], output);
  registrarTemporario(output);
}

async function aplicarLogo(input, output) {
  if (!fs.existsSync('logo.png')) {
    fs.copyFileSync(input, output);
    return;
  }

  await executarFFmpeg([
    '-i', input,
    '-i', 'logo.png',
    '-filter_complex',
    '[1:v]scale=200:-1[logo];[0:v][logo]overlay=W-w-20:20',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-ar', '44100',
    output
  ], output);
  registrarTemporario(output);
}

async function gerarRodapePadrao(nome, duracao = 5) {
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=black:s=1280x120',
    '-t', duracao.toString(),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    nome
  ], nome);
}

async function inserirRodape(video, rodape, saida, tempoRodape, pontoInsercao) {
  const antes = saida + '_antes.mp4';
  const depois = saida + '_depois.mp4';
  const trechoRodape = saida + '_rodape.mp4';
  const combinado = saida + '_combinado.mp4';

  await cortarTrecho(video, 0, pontoInsercao, antes);
  await cortarTrecho(video, pontoInsercao + tempoRodape, 9999, depois);
  await cortarTrecho(video, pontoInsercao, tempoRodape, trechoRodape);

  await executarFFmpeg([
    '-i', trechoRodape,
    '-i', rodape,
    '-filter_complex',
    '[0:v]scale=1280:720[vid];[1:v]scale=1280:120[rod];[vid][rod]overlay=0:H-h',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-ar', '44100',
    combinado
  ], combinado);

  const listaConcat = saida + '_lista.txt';
  fs.writeFileSync(listaConcat, [
    `file '${path.resolve(antes)}'`,
    `file '${path.resolve(combinado)}'`,
    `file '${path.resolve(depois)}'`
  ].join('\n'));

  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaConcat, '-c', 'copy', saida], saida);
}

async function unirFinal(arquivos, saida) {
  const lista = 'lista_final.txt';
  fs.writeFileSync(lista, arquivos.map(p => `file '${path.resolve(p)}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', saida], saida);
}

async function main() {
  if (!fs.existsSync(inputFile)) throw new Error(`Arquivo de entrada não encontrado: ${inputFile}`);
  const input = JSON.parse(fs.readFileSync(inputFile));

  const camposObrigatorios = ['id', 'video_principal', 'video_inicial', 'video_miraplay', 'video_final', 'logo_id', 'stream_url'];
  for (const campo of camposObrigatorios) {
    if (!input[campo]) throw new Error(`❌ Campo obrigatório ausente: ${campo}`);
  }

  if (input.rodape_id) {
    await baixarArquivo(input.rodape_id, 'rodape.mp4');
  } else {
    await gerarRodapePadrao('rodape.mp4');
  }

  const durRodape = await obterDuracao('rodape.mp4');

  await baixarArquivo(input.logo_id, 'logo.png');
  await baixarArquivo(input.video_principal, 'principal.mp4');

  const duracaoPrincipal = await obterDuracao('principal.mp4');
  const metade = Math.floor(duracaoPrincipal / 2);
  const pontoRodape = 240;

  await cortarTrecho('principal.mp4', 0, metade, 'parte1.mp4');
  await inserirRodape('parte1.mp4', 'rodape.mp4', 'parte1_rodape.mp4', durRodape, pontoRodape);
  await aplicarLogo('parte1_rodape.mp4', 'parte1_final.mp4');

  await cortarTrecho('principal.mp4', metade, duracaoPrincipal - metade, 'parte2.mp4');
  await inserirRodape('parte2.mp4', 'rodape.mp4', 'parte2_rodape.mp4', durRodape, pontoRodape);
  await aplicarLogo('parte2_rodape.mp4', 'parte2_final.mp4');

  const ordem = [];
  const extras = [];

  for (let i = 0; i < (input.videos_extras || []).length; i++) {
    const caminhoExtra = input.videos_extras[i];
    const nome = `extra_${i}.mp4`;
    await baixarArquivo(caminhoExtra, nome);
    extras.push(nome);
  }

  await baixarArquivo(input.video_inicial, 'inicial.mp4');
  await baixarArquivo(input.video_miraplay, 'miraplay.mp4');
  await baixarArquivo(input.video_final, 'final.mp4');

  ordem.push('parte1_final.mp4');
  ordem.push('inicial.mp4');
  ordem.push('miraplay.mp4');
  ordem.push(...extras);
  ordem.push('inicial.mp4');
  ordem.push('parte2_final.mp4');
  ordem.push('final.mp4');

  await unirFinal(ordem, 'video_final_completo.mp4');

  const stats = fs.statSync('video_final_completo.mp4');
  const duracao = await obterDuracao('video_final_completo.mp4');
  const tamanho = (stats.size / 1024 / 1024).toFixed(2);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id,
    stream_url: input.stream_url,
    duracao,
    tamanho_mb: tamanho
  }, null, 2));

  console.log(`✅ Vídeo final pronto: video_final_completo.mp4`);
  console.log(`⏱️  Duração: ${duracao.toFixed(2)} segundos`);
  console.log(`💾 Tamanho: ${tamanho} MB`);
}

main().catch(err => {
  console.error('❌ Erro no processamento:', err.message || err);
  process.exit(1);
});
