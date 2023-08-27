import type { Note } from "kirika"
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

type FileNameFormat = "id" | "created_at" | "updated_at" | "title"

type MemosSyncPluginSettings = {
  openAPI: string
  folderToSync: string
  fileNameFormat: FileNameFormat
  lastSyncTime?: number
}

const DEFAULT_SETTINGS: MemosSyncPluginSettings = {
  openAPI: "",
  folderToSync: "Memos Sync",
  fileNameFormat: "id",
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

  async onload() {
    await this.loadSettings()

    this.addRibbonIcon("refresh-ccw", "Memos Sync", this.sync.bind(this))
    this.addSettingTab(new MemosSyncSettingTab(this.app, this))
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData())
  }

  async saveSettings() {
    await this.saveData(this.settings)
  }

  async sync() {
    await this.loadSettings()
    const { openAPI, folderToSync, lastSyncTime } = this.settings

    if (openAPI === "") {
      new Notice("Please enter your OpenAPI key.")
      return
    }

    try {
      new Notice("Started syncing memos...")

      const res = await readMemosFromOpenAPI(openAPI)
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
        adapter.write(memoPath, memoContent)
      })

      res.files.forEach(async (resource) => {
        const resourcePath = normalizePath(
          `${folderToSync}/resources/${resource.filename}`,
        )

        const isResourceExists = await adapter.exists(resourcePath)
        if (isResourceExists) {
          return
        }

        const resourceContent = await getAttachmentContent(resource)
        if (!resourceContent) {
          return
        }
        adapter.writeBinary(resourcePath, resourceContent)
      })

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
      memosInVault.files.forEach(async (memo) => {
        if (!memosInAPI.includes(memo)) {
          await adapter.remove(memo)
        }
      })

      const resourcesInVault = await adapter.list(`${folderToSync}/resources`)
      resourcesInVault.files.forEach(async (resource) => {
        if (!resourcesInAPI.includes(resource)) {
          await adapter.remove(resource)
        }
      })

      new Notice("Successfully synced memos.")

      this.saveData({
        ...this.settings,
        lastSyncTime: Date.now(),
      })
    } catch (e) {
      new Notice(
        "Failed to sync memos. Please check your OpenAPI key and network.",
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
      .setName("OpenAPI")
      .setDesc("Find your OpenAPI key at your Memos Settings.")
      .addText((text) =>
        text
          .setPlaceholder("Enter your OpenAPI key")
          .setValue(this.plugin.settings.openAPI)
          .onChange(async (value) => {
            this.plugin.settings.openAPI = value
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
  }
}
