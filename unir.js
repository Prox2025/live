const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rcloneConfigPath = path.join(process.env.HOME || '', '.config/rclone/rclone.conf');
const inputFile = 'input.json';
const remoteName = 'meudrive'; // remote configurado no rclone.conf

const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function executarComando(cmd, args, outputDescricao) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Executando: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', data => process.stdout.write(data));
    proc.stderr.on('data', data => process.stderr.write(data));

    proc.on('close', code => {
      if (code === 0) {
        if (outputDescricao) console.log(`✅ ${outputDescricao} criado.`);
        resolve();
      } else {
        reject(new Error(`${cmd} falhou com código ${code}`));
      }
    });
  });
}

async function baixarArquivoPorId(id, destino) {
  if (!id) throw new Error('ID do arquivo para download está vazio');
  console.log(`📥 Baixando arquivo do Drive: ${id} para ${destino}`);
  return new Promise((resolve, reject) => {
    const rclone = spawn('rclone', [
      'copyto',
      `${remoteName}:${id}`,
      destino,
      '--config',
      rcloneConfigPath,
      '--drive-export-formats',
      'mp4,webm'
    ]);
    rclone.stdout.on('data', data => process.stdout.write(data));
    rclone.stderr.on('data', data => process.stderr.write(data));
    rclone.on('close', code => {
      if (code === 0) {
        if (!fs.existsSync(destino)) {
          return reject(new Error(`Arquivo não encontrado após rclone copyto: ${destino}`));
        }
        registrarTemporario(destino);
        resolve();
      } else {
        reject(new Error(`rclone copyto falhou com código ${code}`));
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
    let output = '';
    ffprobe.stdout.on('data', data => output += data.toString());
    ffprobe.stderr.on('data', data => process.stderr.write(data));
    ffprobe.on('close', () => {
      const dur = parseFloat(output.trim());
      if (isNaN(dur)) {
        reject(new Error(`Não foi possível obter duração de ${video}`));
      } else {
        resolve(dur);
      }
    });
  });
}

async function cortarTrecho(input, inicio, duracao, output) {
  console.log(`✂️ Cortando trecho: ${input} [início: ${inicio}s, duração: ${duracao}s] -> ${output}`);
  await executarComando('ffmpeg', [
    '-y',
    '-i', input,
    '-ss', inicio.toString(),
    '-t', duracao.toString(),
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ], output);
  registrarTemporario(output);
}

async function aplicarLogo(input, output) {
  if (!fs.existsSync('logo.png')) {
    console.log('⚠️ logo.png não encontrado. Copiando vídeo original...');
    fs.copyFileSync(input, output);
    return;
  }
  console.log(`🎨 Aplicando logo a ${input} -> ${output}`);
  await executarComando('ffmpeg', [
    '-y',
    '-i', input,
    '-i', 'logo.png',
    '-filter_complex', '[1:v]scale=iw/7:-1[logo];[0:v][logo]overlay=W-w-10:10',
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    output
  ], output);
  registrarTemporario(output);
}

async function inserirRodape(video, rodape, saida, durRodape, posInsercao) {
  console.log(`🔖 Inserindo rodapé em ${video} na posição ${posInsercao}s (duração rodapé ${durRodape}s)`);
  const parteAntes = saida + '_antes.mp4';
  const parteRodape = saida + '_rodape.mp4';
  const parteDepois = saida + '_depois.mp4';
  const combinado = saida + '_combinado.mp4';

  // Cortar antes do rodapé
  await cortarTrecho(video, 0, posInsercao, parteAntes);
  // Cortar trecho do rodapé
  await cortarTrecho(video, posInsercao, durRodape, parteRodape);
  // Cortar depois do rodapé
  const durTotal = await obterDuracao(video);
  const durDepois = durTotal - (posInsercao + durRodape);
  await cortarTrecho(video, posInsercao + durRodape, durDepois, parteDepois);

  // Sobrepor rodapé
  await executarComando('ffmpeg', [
    '-y',
    '-i', parteRodape,
    '-i', rodape,
    '-filter_complex',
    '[0:v]scale=iw:ih*0.8,pad=iw:ih+ih*0.2:0:0[vid];[1:v]scale=iw:-1[rod];[vid][rod]overlay=0:H-h',
    '-c:v', 'libx264',
    '-crf', '20',
    '-preset', 'slow',
    '-c:a', 'aac',
    '-b:a', '128k',
    combinado
  ], combinado);
  registrarTemporario(combinado);

  // Concatenar tudo
  const listaConcat = saida + '_lista.txt';
  const listaConteudo = [
    `file '${path.resolve(parteAntes)}'`,
    `file '${path.resolve(combinado)}'`,
    `file '${path.resolve(parteDepois)}'`
  ].join('\n');
  fs.writeFileSync(listaConcat, listaConteudo);
  registrarTemporario(listaConcat);

  await executarComando('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listaConcat,
    '-c', 'copy',
    saida
  ], saida);
  registrarTemporario(saida);
}

async function unirVideosLista(lista, saida) {
  console.log(`🔗 Unindo vídeos em ${saida}`);
  const listaTxt = 'lista_uniao.txt';
  fs.writeFileSync(listaTxt, lista.map(v => `file '${path.resolve(v)}'`).join('\n'));
  registrarTemporario(listaTxt);

  await executarComando('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listaTxt,
    '-c', 'copy',
    saida
  ], saida);
  registrarTemporario(saida);
}

async function main() {
  try {
    if (!fs.existsSync(inputFile)) throw new Error('Arquivo input.json não encontrado');

    const inputRaw = fs.readFileSync(inputFile);
    const input = JSON.parse(inputRaw);

    // Verificações básicas
    const obrigatorios = ['id', 'video_principal', 'video_inicial', 'video_miraplay', 'video_final', 'logo_id', 'stream_url'];
    for (const campo of obrigatorios) {
      if (!input[campo] || (typeof input[campo] === 'string' && input[campo].trim() === '')) {
        throw new Error(`Campo obrigatório "${campo}" ausente ou vazio no input.json`);
      }
    }

    console.log('✅ Todos os dados obrigatórios presentes.');

    // Preparar rodapé
    let rodapePath = '';
    if (input.rodape_id && input.rodape_id.trim() !== '') {
      rodapePath = 'rodape.webm';
      await baixarArquivoPorId(input.rodape_id, rodapePath);
    } else {
      console.log('⚠️ Rodapé não fornecido. Usando vídeo sem rodapé.');
      // Criar vídeo vazio para rodapé? Ou pode pular
      rodapePath = '';
    }

    // Baixar vídeo principal
    await baixarArquivoPorId(input.video_principal, 'principal.mp4');
    const duracaoPrincipal = await obterDuracao('principal.mp4');
    console.log(`🎬 Duração vídeo principal: ${duracaoPrincipal.toFixed(2)}s`);

    // Cortar metade para exemplo
    const metade = Math.floor(duracaoPrincipal / 2);

    // Processar primeira metade com rodapé e logo
    await cortarTrecho('principal.mp4', 0, metade, 'parte1.mp4');
    if (rodapePath) {
      await inserirRodape('parte1.mp4', rodapePath, 'parte1_final.mp4', await obterDuracao(rodapePath), 10);
    } else {
      fs.copyFileSync('parte1.mp4', 'parte1_final.mp4');
    }
    await aplicarLogo('parte1_final.mp4', 'parte1_logo.mp4');

    // Processar segunda metade com rodapé e logo
    const segDur = duracaoPrincipal - metade;
    await cortarTrecho('principal.mp4', metade, segDur, 'parte2.mp4');
    if (rodapePath) {
      await inserirRodape('parte2.mp4', rodapePath, 'parte2_final.mp4', await obterDuracao(rodapePath), 10);
    } else {
      fs.copyFileSync('parte2.mp4', 'parte2_final.mp4');
    }
    await aplicarLogo('parte2_final.mp4', 'parte2_logo.mp4');

    // Baixar vídeos extras, se houver
    const extras = [];
    if (input.videos_extras && Array.isArray(input.videos_extras) && input.videos_extras.length > 0) {
      for (let i = 0; i < input.videos_extras.length; i++) {
        const idExtra = input.videos_extras[i];
        const nomeExtra = `extra_${i}.mp4`;
        await baixarArquivoPorId(idExtra, nomeExtra);
        extras.push(nomeExtra);
      }
    }

    // Baixar vídeos fixos do sacredi.json
    await baixarArquivoPorId(input.video_inicial, 'inicial.mp4');
    await baixarArquivoPorId(input.video_miraplay, 'miraplay.mp4');
    await baixarArquivoPorId(input.video_final, 'final.mp4');

    // Montar lista para concatenar na ordem desejada
    const listaFinal = [
      'parte1_logo.mp4',
      'inicial.mp4',
      'miraplay.mp4',
      ...extras,
      'inicial.mp4',  // repetido conforme input.json do seu exemplo
      'parte2_logo.mp4',
      'final.mp4'
    ];

    // Concatenar vídeos
    await unirVideosLista(listaFinal, 'video_final_completo.mp4');

    // Informações do vídeo final
    const tamanhoBytes = fs.statSync('video_final_completo.mp4').size;
    const duracaoFinal = await obterDuracao('video_final_completo.mp4');
    const tamanhoMB = (tamanhoBytes / 1024 / 1024).toFixed(2);

    const info = {
      id: input.id,
      stream_url: input.stream_url,
      duracao: duracaoFinal,
      tamanho_mb: tamanhoMB
    };

    fs.writeFileSync('stream_info.json', JSON.stringify(info, null, 2));

    console.log('🎉 Vídeo final criado com sucesso: video_final_completo.mp4');
    console.log(`⏳ Duração: ${duracaoFinal.toFixed(2)} segundos`);
    console.log(`💾 Tamanho: ${tamanhoMB} MB`);

  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
}

main();
