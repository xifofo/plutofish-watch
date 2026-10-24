/** 独立 Electron 客户端入口；关闭窗口留在托盘，退出时等待任务保存。 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { join } from 'node:path'
import { WatchService } from './service'
import createEd2kWorker from './ed2k-worker?nodeWorker'
import { createED2KComputer } from '../../vendor/publisher/src/integrations/plutofish/ed2k-computer'

let window: BrowserWindow | undefined, tray: Tray | undefined, service: WatchService | undefined
let quitting = false, closing: Promise<void> | undefined
let broadcastTimer: ReturnType<typeof setTimeout> | undefined
const showWindow = () => {
  if (quitting || closing || !window || window.isDestroyed()) return
  window.show()
  window.focus()
}
// 测试可以通过独立路径启动空白实例，正式运行从不读取下载器的配置。
const dataArgument = process.argv.find(a => a.startsWith('--watch-data='))
if (dataArgument) app.setPath('userData', dataArgument.slice('--watch-data='.length))
app.setName('PlutoFish Watch')

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', showWindow)
  void app.whenReady().then(async () => {
    const appIcon = nativeImage.createFromPath(join(__dirname, '../../resources/icon.png'))
    app.dock?.setIcon(appIcon)
    service = new WatchService(app.getPath('userData'), () => {
      if (broadcastTimer) return
      broadcastTimer = setTimeout(() => {
        broadcastTimer = undefined
        if (window && !window.isDestroyed()) window.webContents.send('watch:state', service!.snapshot())
      }, 150)
    }, createED2KComputer(path => createEd2kWorker({ workerData: { path } })))
    window = new BrowserWindow({
      width: 1240, height: 840, minWidth: 840, minHeight: 640, title: 'PlutoFish Watch', icon: appIcon,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16191f' : '#f6f7fa', titleBarStyle: 'hiddenInset',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    const currentWindow = window
    currentWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    currentWindow.webContents.on('will-navigate', event => event.preventDefault())
    currentWindow.on('close', event => { if (!quitting) { event.preventDefault(); currentWindow.hide() } })
    currentWindow.on('closed', () => { window = undefined })
    tray = new Tray(appIcon.resize({ width: 20, height: 20 }))
    tray.setToolTip('PlutoFish Watch · 目录监控')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 PlutoFish Watch', click: showWindow },
      { label: '退出', click: () => app.quit() },
    ]))
    tray.on('click', showWindow)
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'PlutoFish Watch', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'quit' }] },
      { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { label: '显示主窗口', click: showWindow }] },
    ]))
    // 写操作串行；只读查询独立执行，重连先取消旧请求以释放正在等待网络的写操作。
    let commands = Promise.resolve()
    ipcMain.handle('watch:command', async (event, action, payload) => {
      if (event.sender !== currentWindow.webContents || event.senderFrame !== currentWindow.webContents.mainFrame) return { ok: false, error: '请求来源无效' }
      const run = async () => {
        try {
          let value: unknown
          const svc = service!
          switch (action) {
            case 'snapshot': value = svc.snapshot(); break
            case 'connect': await svc.connect(payload); break
            case 'releases': value = await svc.releases(payload); break
            case 'searchWorks': value = await svc.searchWorks(payload); break
            case 'recognitionSample': value = await svc.recognitionSample(payload); break
            case 'recognizeFile': value = await svc.recognizeFile(payload); break
            case 'directories': value = await svc.connection.directories(payload.sourceAccountId, payload.directoryId, payload.cursor); break
            case 'createDirectories': value = await svc.connection.createDirectories(payload.sourceAccountId, payload.directoryId, payload.segments); break
            case 'add': await svc.add(payload); break
            case 'updateWatch': await svc.updateWatch(payload); break
            case 'setSourcePreset': await svc.setSourcePreset(payload); break
            case 'setRetention': await svc.setRetention(payload); break
            case 'toggleWatch': await svc.toggleWatch(payload); break
            case 'removeWatch': {
              const result = await dialog.showMessageBox(currentWindow, { type: 'question', message: '移除这个监控目录？', detail: '停止该目录的未完成任务，保留本地文件、网盘文件和任务历史。', buttons: ['保留', '移除监控'], cancelId: 0, defaultId: 0 })
              if (result.response === 1) await svc.removeWatch(payload)
              break
            }
            case 'scan': await svc.watcher.scan(); break
            case 'backfill': value = await svc.backfill(payload); break
            case 'pauseAll': await svc.pauseAll(); break
            case 'job': await svc.job(payload); break
            case 'reveal': {
              const job = svc.store.data.jobs.find(j => j.id === payload)
              if (!job) throw new Error('任务不存在')
              shell.showItemInFolder(job.path); break
            }
            case 'chooseDirectory': {
              const result = await dialog.showOpenDialog(currentWindow, { title: '选择监控目录', properties: ['openDirectory'] })
              value = result.canceled ? null : result.filePaths[0]; break
            }
            case 'chooseProbe': {
              const result = await dialog.showOpenDialog(currentWindow, { title: '选择 ffprobe 程序', properties: ['openFile'] })
              value = result.canceled ? null : result.filePaths[0]
              if (value) await svc.setProbe(value as string)
              break
            }
            default: throw new Error('不支持的操作')
          }
          return { ok: true, value }
        } catch (error) {
          return { ok: false, error: error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '操作失败，请检查输入、网络或本地目录权限' }
        }
      }
      if (['snapshot', 'searchWorks', 'recognitionSample', 'recognizeFile', 'releases', 'directories'].includes(action)) return run()
      if (action === 'connect') service!.connection.cancelRequests()
      const result = commands.then(run, run)
      commands = result.then(() => {})
      return result
    })
    if (process.env.ELECTRON_RENDERER_URL) await currentWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    else await currentWindow.loadFile(join(__dirname, '../renderer/index.html'))
    await service.start()
  }).catch(error => {
    dialog.showErrorBox('PlutoFish Watch 启动失败', error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : '无法读取应用数据，请检查目录权限并保留原始数据后重试。')
    quitting = true; app.quit()
  })
  app.on('activate', showWindow)
  app.on('window-all-closed', () => {})
  app.on('before-quit', event => {
    if (quitting) return
    event.preventDefault()
    closing ??= (service?.close() ?? Promise.resolve()).finally(() => { quitting = true; app.quit() })
  })
}
