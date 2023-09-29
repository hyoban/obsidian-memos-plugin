import type { Authorization, Note } from "kirika"
import {
  getAttachmentContent,
  getNoteContent,
  readMemosFromOpenAPI,
} from "kirika"
import type { App } from "obsidian"
import {
  normalizePath,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian"

/**
 * 每两小时，每小时，每半小时，每15分钟，每5分钟，关闭
 */
type Interval = 120 | 60 | 30 | 15 | 5 | 0

type FileNameFormat = "id" | "created_at" | "updated_at" | "title"

type MemosSyncPluginSettings = {
  auth: Authorization
  folderToSync: string
  fileNameFormat: FileNameFormat
  interval: Interval
  lastSyncTime?: number
}

const DEFAULT_SETTINGS: MemosSyncPluginSettings = {
  auth: {
    baseUrl: "",
  },
  folderToSync: "Memos Sync",
  fileNameFormat: "id",
  interval: 0,
}

function formatDateToFileFormat(date: Date) {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()

  return `${year}-${month}-${day}-${hours}-${minutes}`
}

function getFileName(memo: Note, format: FileNameFormat) {
  switch (format) {
    case "id":
      return memo.id
    case "created_at":
      return formatDateToFileFormat(
        memo.metadata.createdAt
          ? new Date(memo.metadata.createdAt)
          : new Date(),
      )
    case "updated_at":
      return formatDateToFileFormat(
        memo.metadata.updatedAt
          ? new Date(memo.metadata.updatedAt)
          : new Date(),
      )
    case "title":
      return memo.title
  }
}

export default class MemosSyncPlugin extends Plugin {
  settings: MemosSyncPluginSettings
  timer: number | null = null

  async registerSyncInterval() {
    await this.loadSettings()
    const { interval } = this.settings
    if (this.timer) {
      window.clearInterval(this.timer)
    }
    if (interval > 0) {
      this.timer = this.registerInterval(
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        window.setInterval(this.sync.bind(this), interval * 60 * 1000),
      )
    }
  }

  async onload() {
    await this.registerSyncInterval()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    this.addRibbonIcon("refresh-ccw", "Memos Sync", this.sync.bind(this))
    this.addSettingTab(new MemosSyncSettingTab(this.app, this))
  }

  onunload() {}

  async loadSettings() {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  async sync() {
    await this.loadSettings()
    const { auth, folderToSync, lastSyncTime } = this.settings

    if (!auth.baseUrl) {
      new Notice("Please enter the base URL.")
      return
    }

    if (!auth.accessToken && !auth.openId) {
      new Notice("Please enter the access token or open ID.")
      return
    }

    try {
      new Notice("Started syncing memos...")

      const res = await readMemosFromOpenAPI(auth)
      const memos = res.notes.filter((i) => !i.metadata.isArchived)

      const vault = this.app.vault
      const adapter = this.app.vault.adapter

      const isMemosFolderExists = await adapter.exists(`${folderToSync}/memos`)
      if (!isMemosFolderExists) {
        await vault.createFolder(`${folderToSync}/memos`)
      }
      const isResourcesFolderExists = await adapter.exists(
        `${folderToSync}/resources`,
      )
      if (!isResourcesFolderExists) {
        await vault.createFolder(`${folderToSync}/resources`)
      }

      memos.forEach((memo) => {
        const memoPath = normalizePath(
          `${folderToSync}/memos/${getFileName(
            memo,
            this.settings.fileNameFormat,
          )}.md`,
        )
        const memoContent = getNoteContent(memo)
        const lastUpdated = memo.metadata.updatedAt

        if (lastSyncTime && lastUpdated && lastUpdated * 1000 < lastSyncTime) {
          return
        }
        adapter.write(memoPath, memoContent).catch((e) => {
          console.error(e)
        })
      })

      for (const resource of res.files) {
        const resourcePath = normalizePath(
          `${folderToSync}/resources/${resource.filename}`,
        )

        const isResourceExists = await adapter.exists(resourcePath)
        if (isResourceExists) {
          return
        }

        // check if resource.filename includes "/"
        if (resource.filename.includes("/")) {
          const resourcePathSplitted = resource.filename.split("/")
          // create folders recursively
          for (let i = 0; i < resourcePathSplitted.length - 1; i++) {
            const folderPath = normalizePath(
              `${folderToSync}/resources/${resourcePathSplitted
                .slice(0, i + 1)
                .join("/")}`,
            )
            const isFolderExists = await adapter.exists(folderPath)
            if (!isFolderExists) {
              await vault.createFolder(folderPath)
            }
          }
        }

        const resourceContent = await getAttachmentContent(resource, auth)
        if (!resourceContent) {
          return
        }
        adapter.writeBinary(resourcePath, resourceContent).catch((e) => {
          console.error(e)
        })
      }

      // delete memos and resources that are not in the API response
      const memosInAPI = memos.map(
        (memo) =>
          `${folderToSync}/memos/${getFileName(
            memo,
            this.settings.fileNameFormat,
          )}.md`,
      )
      const resourcesInAPI = res.files.map(
        (resource) => `${folderToSync}/resources/${resource.filename}`,
      )

      const memosInVault = await adapter.list(`${folderToSync}/memos`)

      for (const memo of memosInVault.files) {
        if (!memosInAPI.includes(memo)) {
          await adapter.remove(memo)
        }
      }

      const resourcesInVault = await adapter.list(`${folderToSync}/resources`)

      for (const resource of resourcesInVault.files) {
        if (!resourcesInAPI.includes(resource)) {
          await adapter.remove(resource)
        }
      }

      new Notice("Successfully synced memos.")

      this.saveData({
        ...this.settings,
        lastSyncTime: Date.now(),
      }).catch((e) => {
        console.error(e)
      })
    } catch (e) {
      new Notice(
        "Failed to sync memos. Please check your authorization settings and network connection.",
        0,
      )
      console.error(e)
    }
  }
}

class MemosSyncSettingTab extends PluginSettingTab {
  plugin: MemosSyncPlugin

  constructor(app: App, plugin: MemosSyncPlugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display(): void {
    const { containerEl } = this

    containerEl.empty()

    containerEl.createEl("h2", { text: "Settings for Memos Sync." })

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc(
        "* The host of your memos server.(e.g. https://demo.usememos.com)",
      )
      .addText((text) =>
        text
          .setPlaceholder("Enter your Base URL")
          .setValue(this.plugin.settings.auth.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.auth.baseUrl = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("Access Token")
      .setDesc("Set this if your memos version is over 0.15.0.")
      .addText((text) =>
        text
          .setPlaceholder("Enter your access token")
          .setValue(this.plugin.settings.auth.accessToken || "")
          .onChange(async (value) => {
            this.plugin.settings.auth.accessToken = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("Open ID")
      .setDesc("Set this if your memos version is under 0.15.0.")
      .addText((text) =>
        text
          .setPlaceholder("Enter your open ID")
          .setValue(this.plugin.settings.auth.openId || "")
          .onChange(async (value) => {
            this.plugin.settings.auth.openId = ""
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("Folder to sync")
      .setDesc("The folder to sync memos and resources.")
      .addText((text) =>
        text
          .setPlaceholder("Enter the folder name")
          .setValue(this.plugin.settings.folderToSync)
          .onChange(async (value) => {
            if (value === "") {
              new Notice("Please enter the folder name.")
              return
            }
            this.plugin.settings.folderToSync = value
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("File name format")
      .setDesc("The format of the file name for memos.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("id", "ID")
          .addOption("created_at", "Created at")
          .addOption("updated_at", "Updated at")
          .addOption("title", "Title")
          .setValue(this.plugin.settings.fileNameFormat)
          .onChange(async (value) => {
            this.plugin.settings.fileNameFormat = value as FileNameFormat
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName("Sync interval")
      .setDesc("The interval to sync memos.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("0", "Close")
          .addOption("5", "Every 5 minutes")
          .addOption("15", "Every 15 minutes")
          .addOption("30", "Every 30 minutes")
          .addOption("60", "Every 1 hour")
          .addOption("120", "Every 2 hours")
          .setValue(String(this.plugin.settings.interval))
          .onChange(async (value) => {
            this.plugin.settings.interval = Number(value) as Interval
            await this.plugin.saveSettings()
            await this.plugin.registerSyncInterval()
          }),
      )
  }
}
