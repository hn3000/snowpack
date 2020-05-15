import {EventEmitter} from 'events';
import ansiEscapes from 'ansi-escapes';
import chalk from 'chalk';
import util from 'util';
import readline from 'readline';
import {DevScript} from '../config';
import {addCommand} from './add-rm';

function getStateString(workerState: any, isWatch: boolean) {
  if (workerState.state) {
    if (Array.isArray(workerState.state)) {
      return chalk[workerState.state[1]](workerState.state[0]);
    }
    return chalk.dim(workerState.state);
  }
  if (workerState.done) {
    return workerState.error ? chalk.red('FAILED') : chalk.green('DONE');
  }
  if (isWatch) {
    if (workerState.config.watch) {
      return chalk.dim('WATCHING');
    }
  }
  return chalk.dim('READY');
}

const WORKER_BASE_STATE = {done: false, error: null, output: ''};

export function paint(
  bus: EventEmitter,
  registeredWorkers: DevScript[],
  buildMode: {dest: string} | undefined,
  devMode:
    | {
        port: number;
        ips: string[];
        startTimeMs: number;
        addPackage: (pkgName: string, needsAdd: boolean) => void;
      }
    | undefined,
) {
  let consoleOutput = '';
  let hasBeenCleared = false;
  let missingWebModuleIsInstalled = false;
  let missingWebModule: null | string = null;
  const allWorkerStates: any = {};

  for (const config of registeredWorkers) {
    allWorkerStates[config.id] = {...WORKER_BASE_STATE, config};
  }

  function repaint() {
    process.stdout.write(ansiEscapes.clearTerminal);
    process.stdout.write(`${chalk.bold('Snowpack')}\n\n`);
    // Dashboard
    if (devMode) {
      process.stdout.write(`  ${chalk.bold.cyan(`http://localhost:${devMode.port}`)}`);
      for (const ip of devMode.ips) {
        process.stdout.write(
          `${chalk.cyan(` > `)}${chalk.bold.cyan(`http://${ip}:${devMode.port}`)}`,
        );
      }
      process.stdout.write('\n' + chalk.dim(`  Server started in ${devMode.startTimeMs}ms.\n\n`));
    }
    if (buildMode) {
      process.stdout.write('  ' + chalk.bold.cyan(buildMode.dest));
      process.stdout.write(chalk.dim(` Building your application...\n\n`));
    }

    for (const config of registeredWorkers) {
      const workerState = allWorkerStates[config.id];
      const dotLength = 24 - config.id.length;
      const dots = ''.padEnd(dotLength, '.');
      const stateStr = getStateString(workerState, !!devMode);
      process.stdout.write(`  ${config.id}${chalk.dim(dots)}[${stateStr}]\n`);
    }
    process.stdout.write('\n');
    if (missingWebModule) {
      let [missingPackageName, ...deepPackagePathParts] = missingWebModule.split('/');
      if (missingPackageName.startsWith('@')) {
        missingPackageName += '/' + deepPackagePathParts.shift();
      }
      process.stdout.write(`${chalk.red.underline.bold('▼ Snowpack')}\n\n`);
      if (missingWebModuleIsInstalled) {
        process.stdout.write(`  New import ${chalk.bold(missingWebModule)} found!\n\n`);
        process.stdout.write(`  ${chalk.bold('Press Enter')} to install it with Snowpack.\n\n`);
      } else {
        process.stdout.write(`  Package ${chalk.bold(missingWebModule)} could not be found!\n\n`);
        process.stdout.write(`  ${chalk.bold('Press Enter')} to install it with Snowpack.\n\n`);
      }
      return;
    }
    for (const config of registeredWorkers) {
      const workerState = allWorkerStates[config.id];
      if (workerState && workerState.output) {
        const chalkFn = Array.isArray(workerState.error) ? chalk.red : chalk;
        process.stdout.write(`${chalkFn.underline.bold('▼ ' + config.id)}\n\n`);
        process.stdout.write(
          workerState.output
            ? '  ' + workerState.output.trim().replace(/\n/gm, '\n  ')
            : hasBeenCleared
            ? chalk.dim('  Output cleared.')
            : chalk.dim('  No output, yet.'),
        );
        process.stdout.write('\n\n');
      }
    }
    if (consoleOutput) {
      process.stdout.write(`${chalk.underline.bold('▼ Console')}\n\n`);
      process.stdout.write(
        consoleOutput
          ? '  ' + consoleOutput.trim().replace(/\n/gm, '\n  ')
          : hasBeenCleared
          ? chalk.dim('  Output cleared.')
          : chalk.dim('  No output, yet.'),
      );
      process.stdout.write('\n\n');
    }
    const overallStatus: any = Object.values(allWorkerStates).reduce(
      (result: any, {done, error}: any) => {
        return {
          done: result.done && done,
          error: result.error || error,
        };
      },
    );
    if (overallStatus.error) {
      process.stdout.write(`${chalk.underline.red.bold('▼ Result')}\n\n`);
      process.stdout.write('  ⚠️  Finished, with errors.');
      process.stdout.write('\n\n');
      process.exit(1);
    } else if (overallStatus.done) {
      process.stdout.write(`${chalk.underline.green.bold('▶ Build Complete!')}\n\n`);
    }
  }

  bus.on('WORKER_MSG', ({id, msg}) => {
    allWorkerStates[id].output += msg;
    repaint();
  });
  bus.on('WORKER_UPDATE', ({id, state}) => {
    if (typeof state !== undefined) {
      allWorkerStates[id].state = state;
    }
    repaint();
  });
  bus.on('WORKER_COMPLETE', ({id, error}) => {
    allWorkerStates[id].state = null;
    allWorkerStates[id].done = true;
    allWorkerStates[id].error = allWorkerStates[id].error || error;
    repaint();
  });
  bus.on('WORKER_RESET', ({id}) => {
    allWorkerStates[id] = {...WORKER_BASE_STATE, config: allWorkerStates[id].config};
    repaint();
  });
  bus.on('CONSOLE', ({level, args}) => {
    consoleOutput += `[${level}] ${util.format.apply(util, args)}\n`;
    repaint();
  });
  bus.on('NEW_SESSION', () => {
    if (!missingWebModule && consoleOutput) {
      consoleOutput = ``;
      hasBeenCleared = true;
    }
    missingWebModule = null;
    repaint();
  });
  bus.on('MISSING_WEB_MODULE', ({specifier, isInstalled}) => {
    missingWebModule = specifier;
    missingWebModuleIsInstalled = isInstalled;
    repaint();
  });

  if (devMode) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.on('line', (input) => {
      if (!missingWebModule) {
        return;
      }

      devMode.addPackage(missingWebModule, !missingWebModuleIsInstalled);
      repaint();
    });
  }

  // unmountDashboard = render(<App bus={bus} registeredWorkers={registeredWorkers} />).unmount;
  repaint();
}
