/* eslint-disable no-console */
import type { RequestData } from '~~/types'
import type { GithubTree, ResponseDify, Subtitles } from '../types'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { experimental_createMCPClient as createMCPClient, generateObject, generateText } from 'ai'
import TurndownService from 'turndown'
import { z } from 'zod'
import { countTotalDisplayLineBlocks, getGithubFiles, parseWorkflowStreamAndReturnOutputs, sha1, splitOriginalStringByDisplayLines, updateGithubFiles } from '../utiles'
import { formatPrompt, rewritePrompt, slidesPrompt, subtitlesPrompt } from '../utiles/constants'

const turndownService = new TurndownService()

export default defineEventHandler(async (event) => {
  const runtimeConfig = useRuntimeConfig()
  const body = await readBody<RequestData>(event)
  const google = createGoogleGenerativeAI({
    apiKey: runtimeConfig.aiApiKey || '',
  })
  const model = google(runtimeConfig.aiModel || 'gemini-1.5-flash')

  const { elementData, botInfo, contents, sha1: contentsSha1 } = body.taskData

  try {
    if (body && !botInfo) {
      throw createError({
        status: 400,
        statusMessage: 'Bad Request',
        message: 'Missing bot info',
      })
    }

    let innerHTML_UniqueID = contentsSha1
    let md = ''
    if (elementData && elementData.innerHTML) {
      if (!innerHTML_UniqueID) {
        innerHTML_UniqueID = await sha1(elementData.innerHTML)
      }

      md = turndownService.turndown(elementData.innerHTML)
    }
    else if (contents) {
      if (!innerHTML_UniqueID) {
        innerHTML_UniqueID = await sha1(contents)
      }

      md = turndownService.turndown(contents)
    }
    else {
      throw createError({
        status: 400,
        statusMessage: 'Bad Request',
        message: 'Missing required fields',
      })
    }
    // const mcpClient = await createMCPClient({
    //   transport: {
    //     type: 'sse',
    //     url: 'https://mcp.deepwiki.com/sse',
    //   },
    // })

    setTimeout(async () => {
      const startTime = Date.now()
      try {
        const subtitles = await generateObject({
          model,
          schema: z.object({ subtitles: z.array(z.string()) }),
          messages: [
            { role: 'system', content: rewritePrompt },
            {
              role: 'user',
              content: md,
            },
          ],
        })
        // console.log('rewrite: ', rewrite.text)

        // const subtitles = await generateObject({
        //   model,
        //   schema: z.object({ subtitles: z.array(z.string()) }),
        //   messages: [
        //     { role: 'system', content: subtitlesPrompt },
        //     {
        //       role: 'user',
        //       content: rewrite.text,
        //     },
        //   ],
        // })
        console.log('subtitles: ', subtitles.object.subtitles)

        const slidesOriginal = await generateObject({
          model,
          schema: z.object({
            title: z.string(),
            slides: z.array(z.object({
              page: z.number(),
              slide: z.string(),
              subtitles: z.array(z.string()),
            })),
          }),
          messages: [
            { role: 'system', content: slidesPrompt + md },
            {
              role: 'user',
              content: JSON.stringify(subtitles.object),
            },
          ],
        })

        // const tools = await mcpClient.tools()

        const response = await generateObject({
          model,
          schema: z.object({
            title: z.string(),
            slides: z.array(z.object({
              page: z.number(),
              slide: z.string(),
              subtitles: z.array(z.object({
                zh_CN: z.array(z.string()),
                en: z.array(z.string()),
              })),
            })),
          }),
          messages: [
            { role: 'system', content: formatPrompt },
            {
              role: 'user',
              content: JSON.stringify(slidesOriginal.object),
            },
          ],
        })

        if (!response.object)
          throw new Error('There is no slides')

        const slidesData = response.object

        const slides: ResponseDify[] = slidesData.slides
        const title = slidesData.title as string

        const slaide = slides.map((s, i) => {
          const subtitles: Subtitles = {}
          let headmatter = ''
          s.slide = s.slide.replace(/\n---\n/g, '')
          if (i === 0) {
            headmatter = `
theme: seriph
background: https://cover.sli.dev
title: "${title}"
titleTemplate: '%s - Slaide'
layout: cover
presenter: dev
seoMeta:
  ogTitle: "${title}"
addons:
  - slidev-theme-viplay
subtitlesConfig:
  noTTSDelay: 2000
  ttsApi: "https://edgetts.deno.dev/v1/audio/speech"
  ttsLangName:
    en: "English(US)"
    zh_CN: "中文(简体)"
  apiCustom:
    voice: 'rate:-0.2|pitch:0.1'
  ttsModel:
    zh_CN:
      - value: "zh-CN-YunjianNeural"
        display: "云间"
      - value: "zh-CN-XiaoxiaoNeural"
        display: "晓晓"
    en:
      - value: "en-US-AndrewNeural"
        display: "Andrew"
      - value: "en-US-AriaNeural"
        display: "Aria"
`
          }
          else {
            //             const count = countTotalDisplayLineBlocks(s.slide)
            //             if (count < 10) {
            //               const layout = s.slide.length % 2 ? 'image-left' : 'image-right'
            //               headmatter = `
            // layout: ${layout}
            // image: "https://cover.sli.dev"
            // `
            //             }
            //             else {
            //               headmatter = `
            // layout: two-cols
            // `
            //               const lines = splitOriginalStringByDisplayLines(s.slide, Math.ceil(count / 2), count)
            //               s.slide = `${lines.left}\n\n::right::\n\n${lines.right}`
            //             }
          }
          s.subtitles?.forEach((subtitle, index) => {
            if (index === 0) {
              subtitles.default = subtitle
            }
            else {
              subtitles[`click${index}`] = subtitle
            }
          })
          const subtitlesStr = s.subtitles?.length ? `subtitles: ${JSON.stringify(subtitles).replace(/\*\*/g, '')}` : ''
          return `---\npage: ${s.page}${headmatter}${subtitlesStr}\n---\n\n${s.slide}`
        }).join('\n\n')

        const duration = (Date.now() - startTime) / 1000

        // const slidesDir = path.join(__dirname, '../slides')
        // if (!fs.existsSync(slidesDir)) {
        //   fs.mkdirSync(slidesDir, { recursive: true })
        // }

        // Generate filename with timestamp if file exists
        const timestamp = Date.now()
        let slaideName = `${innerHTML_UniqueID}.md`
        let counter = 1
        const slidesFiles = await getGithubFiles('slides')
        let slidesFile = slidesFiles.find(file => file.name === slaideName)

        while (slidesFile) {
          slaideName = `${innerHTML_UniqueID}-${timestamp}-${counter}.md`
          counter++
          slidesFile = slidesFiles.find(file => file.name === slaideName)
        }

        // Write data to markdown file
        // try {
        //   fs.writeFileSync(path.join(slidesDir, slaideName), slaide)
        // }
        // catch (error) {
        //   console.error(`Error writing to file ${slaideName}:`, error)
        //   throw error
        // }

        const updateFiles: GithubTree[] = [
          {
            path: `contents/${innerHTML_UniqueID}.md`,
            mode: '100644',
            content: md,
            type: 'blob',
          },
          {
            path: `slides/${slaideName}`,
            mode: '100644',
            content: slaide,
            type: 'blob',
          },
        ]

        // console.log('update github files')
        await updateGithubFiles(updateFiles, slaideName, botInfo)
        // console.log('update github files done')
        const text = `👨‍💻 Deploying...\n\nTitle: ${title}\nID: ${innerHTML_UniqueID}\nDuration: ${duration} seconds`
        if (botInfo.tgBot) {
          $fetch(`https://api.telegram.org/bot${botInfo.tgBot.token}/sendMessage`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: {
              chat_id: botInfo.tgBot.chatId,
              text,
            },
          })
        }
        if (botInfo.feishuBot) {
          $fetch(botInfo.feishuBot.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: {
              msg_type: 'text',
              content: {
                text,
              },
            },
          })
        }
      }
      catch (error: any) {
        const duration = (Date.now() - startTime) / 1000
        const text = `❌ Error\n\nID: ${innerHTML_UniqueID}\nMessage: ${error.message}\nDuration: ${duration}`
        if (botInfo.tgBot) {
          fetch(`https://api.telegram.org/bot${botInfo.tgBot.token}/sendMessage`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              chat_id: botInfo.tgBot.chatId,
              text,
            }),
          }).catch((error) => {
            console.log(error.message)
          })
        }
        if (botInfo.feishuBot) {
          fetch(botInfo.feishuBot.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              msg_type: 'text',
              content: {
                text,
              },
            }),
          }).catch((error) => {
            console.log(error.message)
          })
        }
      }
      finally {
        // await mcpClient?.close()
      }
    })

    // 返回给 Chrome 插件的响应
    return {
      success: true,
      message: '数据已在服务器接收并已处理。',
      contentId: innerHTML_UniqueID, // 返回这个基于内容的唯一ID
    }
  }
  catch (error: any) {
    console.error('API: 处理 /api/initiate-task 请求时出错:', error)
    throw createError({
      status: 500,
      statusMessage: 'Internal Server Error',
      message: error.message || '服务器内部错误 (Internal Server Error)',
    })
  }
})
