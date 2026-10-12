import { dumpXml, listDevices, pickSerial, runAdb } from './adb.ts';
import { baseConfig, loadAuth, resolveJevKey, saveAuth } from './config.ts';
import { parseDump, screenState } from './perception.ts';
import { runStdio } from './server.ts';
import { runTask } from './task.ts';

function usage(): void {
  console.log(`jev-adb — JEV-powered Android control over ADB
  jev-adb mcp                          Run the MCP server over stdio
  jev-adb doctor                       adb, devices, JEV key, authorizations
  jev-adb devices                      List attached devices
  jev-adb authorize <serial>           Record user approval for a device
  jev-adb observe [serial]             Print the compact screen model
  jev-adb task "<goal>" [serial]       Run an autonomous task (bounded)`);
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'mcp':
        await runStdio();
        return;
      case 'doctor': {
        try {
          const { stdout } = await runAdb(['version']);
          console.log(`adb: ${stdout.split('\n')[0]}`);
        } catch (e) {
          console.log(`adb: MISSING (${(e as Error).message})`);
        }
        const devs = await listDevices().catch(() => []);
        console.log(devs.length ? `devices: ${devs.map((d) => `${d.serial} [${d.state}/${d.transport}]`).join(', ')}` : 'devices: none attached');
        console.log(resolveJevKey() ? 'jev key: configured' : 'jev key: MISSING');
        const a = loadAuth().authorizedDevices;
        console.log(a.length ? `authorized: ${a.join(', ')}` : 'authorized: none');
        return;
      }
      case 'devices': {
        const devs = await listDevices();
        console.log(devs.length ? devs.map((d) => `${d.serial} state=${d.state} transport=${d.transport}`).join('\n') : 'No devices attached.');
        return;
      }
      case 'authorize': {
        const serial = args[0];
        if (!serial) throw new Error('usage: jev-adb authorize <serial>');
        const devs = await listDevices();
        if (!devs.some((d) => d.serial === serial && d.state === 'device')) throw new Error(`Device ${serial} not attached/ready.`);
        const auth = loadAuth();
        if (!auth.authorizedDevices.includes(serial)) {
          auth.authorizedDevices.push(serial);
          saveAuth(auth);
        }
        console.log(`Device ${serial} authorized.`);
        return;
      }
      case 'observe': {
        const s = await pickSerial(args[0], baseConfig().defaultDevice);
        console.log(screenState(parseDump(s, await dumpXml(s))));
        return;
      }
      case 'task': {
        const goal = args[0];
        if (!goal) throw new Error('usage: jev-adb task "<goal>" [serial]');
        const r = await runTask(goal, { serial: args[1] });
        console.log(`${r.done ? 'DONE' : 'NOT DONE'}: ${r.reason}\nsteps: ${r.steps.length} cost: $${r.totalCostUsd.toFixed(5)}`);
        for (const st of r.steps) console.log(`  ${st.n}. ${st.action} ${st.detail} (p=${st.confidence.toFixed(2)})`);
        process.exitCode = r.done ? 0 : 1;
        return;
      }
      default:
        usage();
        process.exitCode = 2;
    }
  } catch (e) {
    console.error(`jev-adb: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
