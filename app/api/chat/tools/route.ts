import { openapiToFunctions } from "@/lib/openapi-conversion"
import { checkApiKey, getServerProfile } from "@/lib/server/server-chat-helpers"
import { Tables } from "@/supabase/types"
import {
  ChatSettings,
  DEFAULT_AIRFORCE_IMAGE_GENERATOR_NAME,
  DEFAULT_POLLINATIONS_IMAGE_GENERATOR_NAME
} from "@/types"
import { OpenAIStream, StreamingTextResponse } from "ai"
import OpenAI from "openai"
import { ChatCompletionCreateParamsBase } from "openai/resources/chat/completions.mjs"
import { getToolById } from "@/db/tools"
import { DEFAULT_AIRFORCE_AUDIO_GENERATOR_NAME } from "@/types/airforce-audio"
import { DEFAULT_YOUDAO_AUDIO_GENERATOR_NAME } from "@/types/youdao-audio"

export async function POST(request: Request) {
  const json = await request.json()
  const { chatSettings, messages, selectedTools } = json as {
    chatSettings: ChatSettings
    messages: any[]
    selectedTools: Tables<"tools">[]
  }

  console.log("Selected tools:", selectedTools)

  const processTool = tool => {
    const { url, schema } = tool

    console.log("URL:", url)
    console.log("Schema:", schema)

    if (typeof schema !== "string") {
      return new Response("Invalid schema format", { status: 400 })
    }

    try {
      const parsedSchema = JSON.parse(schema)
      const { default_parameters: defaultParameters } = parsedSchema || {}

      if (!defaultParameters) {
        throw new Error("Default parameters are missing.")
      }

      const { seed, width, height, size, model } = defaultParameters
      const lastMessage = messages[messages.length - 1]
      const encodedContent = encodeURIComponent(lastMessage.content)

      let fullUrl

      if (tool.name === DEFAULT_AIRFORCE_IMAGE_GENERATOR_NAME) {
        // `airforce` tool
        fullUrl = `${url}?prompt=${encodedContent}&${new URLSearchParams({ seed, model, ...(size && { size }) }).toString()}`
      } else if (tool.name === DEFAULT_POLLINATIONS_IMAGE_GENERATOR_NAME) {
        // `pollinations` tool
        fullUrl = `${url}${encodedContent}?${new URLSearchParams({ seed, model, ...(width && { width }), ...(height && { height }) }).toString()}`
      }

      console.log("Full URL:", fullUrl)

      return new Response(fullUrl, {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    } catch (error) {
      console.error("Error processing schema:", error)
      return new Response("Error processing request", { status: 400 })
    }
  }

  try {
    const profile = await getServerProfile()

    const pollinationTool = selectedTools.find(
      tool => tool.name === DEFAULT_POLLINATIONS_IMAGE_GENERATOR_NAME
    )
    if (pollinationTool) {
      return processTool(pollinationTool)
    }

    const airforceTool = selectedTools.find(
      tool => tool.name === DEFAULT_AIRFORCE_IMAGE_GENERATOR_NAME
    )
    if (airforceTool) {
      return processTool(airforceTool)
    }

    const airforceAudioTool = selectedTools.find(
      tool => tool.name === DEFAULT_AIRFORCE_AUDIO_GENERATOR_NAME
    )

    if (airforceAudioTool) {
      try {
        const { url, schema } = airforceAudioTool
        const parsedSchema = JSON.parse(schema as string)
        if (!parsedSchema) {
          throw new Error("Invalid schema format")
        }
        const { default_parameters: defaultParameters } = parsedSchema || {}

        if (!defaultParameters) {
          throw new Error("Default parameters are missing.")
        }

        const { voice } = defaultParameters
        const lastMessage = messages[messages.length - 1]
        const encodedContent = encodeURIComponent(lastMessage.content)

        const fullUrl = `${url}?text=${encodedContent}&voice=${voice}`

        return new Response(fullUrl, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        })
      } catch (error) {
        console.error("Error processing schema:", error)
        return new Response("Error processing request", { status: 400 })
      }
    }

    const youdaoAudioTool = selectedTools.find(
      tool => tool.name === DEFAULT_YOUDAO_AUDIO_GENERATOR_NAME
    )
    if (youdaoAudioTool) {
      try {
        const { url, schema } = youdaoAudioTool
        const parsedSchema = JSON.parse(schema as string)
        if (!parsedSchema) {
          throw new Error("Invalid schema format")
        }
        const { default_parameters: defaultParameters } = parsedSchema || {}

        if (!defaultParameters) {
          throw new Error("Default parameters are missing.")
        }

        const { type, le } = defaultParameters
        const lastMessage = messages[messages.length - 1]
        const encodedContent = encodeURIComponent(lastMessage.content)

        const fullUrl = `${url}?audio=${encodedContent}&type=${type}&le=${le}`

        return new Response(fullUrl, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        })
      } catch (error) {
        console.error("Error processing schema:", error)
        return new Response("Error processing request", { status: 400 })
      }
    }

    checkApiKey(profile.openai_api_key, "OpenAI")

    const openai = new OpenAI({
      apiKey: profile.openai_api_key || "",
      organization: profile.openai_organization_id
    })

    let allTools: OpenAI.Chat.Completions.ChatCompletionTool[] = []
    let allRouteMaps = {}
    let schemaDetails = []

    for (const selectedTool of selectedTools) {
      try {
        const convertedSchema = await openapiToFunctions(
          JSON.parse(selectedTool.schema as string)
        )
        const tools = convertedSchema.functions || []
        allTools = allTools.concat(tools)

        const routeMap = convertedSchema.routes.reduce(
          (map: Record<string, string>, route) => {
            map[route.path.replace(/{(\w+)}/g, ":$1")] = route.operationId
            return map
          },
          {}
        )

        allRouteMaps = { ...allRouteMaps, ...routeMap }

        schemaDetails.push({
          title: convertedSchema.info.title,
          description: convertedSchema.info.description,
          url: convertedSchema.info.server,
          headers: selectedTool.custom_headers,
          routeMap,
          requestInBody: convertedSchema.routes[0].requestInBody
        })
      } catch (error: any) {
        console.error("Error converting schema", error)
      }
    }

    const firstResponse = await openai.chat.completions.create({
      model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
      messages,
      tools: allTools.length > 0 ? allTools : undefined
    })

    const message = firstResponse.choices[0].message
    messages.push(message)
    const toolCalls = message.tool_calls || []

    if (toolCalls.length === 0) {
      return new Response(message.content, {
        headers: {
          "Content-Type": "application/json"
        }
      })
    }

    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const functionCall = toolCall.function
        const functionName = functionCall.name
        const argumentsString = toolCall.function.arguments.trim()
        const parsedArgs = JSON.parse(argumentsString)

        // Find the schema detail that contains the function name
        const schemaDetail = schemaDetails.find(detail =>
          Object.values(detail.routeMap).includes(functionName)
        )

        if (!schemaDetail) {
          throw new Error(`Function ${functionName} not found in any schema`)
        }

        const pathTemplate = Object.keys(schemaDetail.routeMap).find(
          key => schemaDetail.routeMap[key] === functionName
        )

        if (!pathTemplate) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        const path = pathTemplate.replace(/:(\w+)/g, (_, paramName) => {
          const value = parsedArgs.parameters[paramName]
          if (!value) {
            throw new Error(
              `Parameter ${paramName} not found for function ${functionName}`
            )
          }
          return encodeURIComponent(value)
        })

        if (!path) {
          throw new Error(`Path for function ${functionName} not found`)
        }

        // Determine if the request should be in the body or as a query
        const isRequestInBody = schemaDetail.requestInBody
        let data = {}

        if (isRequestInBody) {
          // If the type is set to body
          let headers = {
            "Content-Type": "application/json"
          }

          // Check if custom headers are set
          const customHeaders = schemaDetail.headers // Moved this line up to the loop
          // Check if custom headers are set and are of type string
          if (customHeaders && typeof customHeaders === "string") {
            let parsedCustomHeaders = JSON.parse(customHeaders) as Record<
              string,
              string
            >

            headers = {
              ...headers,
              ...parsedCustomHeaders
            }
          }

          const fullUrl = schemaDetail.url + path

          const bodyContent = parsedArgs.requestBody || parsedArgs

          const requestInit = {
            method: "POST",
            headers,
            body: JSON.stringify(bodyContent) // Use the extracted requestBody or the entire parsedArgs
          }

          const response = await fetch(fullUrl, requestInit)

          if (!response.ok) {
            data = {
              error: response.statusText
            }
          } else {
            data = await response.json()
          }
        } else {
          // If the type is set to query
          const queryParams = new URLSearchParams(
            parsedArgs.parameters
          ).toString()
          const fullUrl =
            schemaDetail.url + path + (queryParams ? "?" + queryParams : "")

          let headers = {}

          // Check if custom headers are set
          const customHeaders = schemaDetail.headers
          if (customHeaders && typeof customHeaders === "string") {
            headers = JSON.parse(customHeaders)
          }

          const response = await fetch(fullUrl, {
            method: "GET",
            headers: headers
          })

          if (!response.ok) {
            data = {
              error: response.statusText
            }
          } else {
            data = await response.json()
          }
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: JSON.stringify(data)
        })
      }
    }

    const secondResponse = await openai.chat.completions.create({
      model: chatSettings.model as ChatCompletionCreateParamsBase["model"],
      messages,
      stream: true
    })

    const stream = OpenAIStream(secondResponse)

    return new StreamingTextResponse(stream)
  } catch (error: any) {
    console.error(error)
    const errorMessage = error.error?.message || "An unexpected error occurred"
    const errorCode = error.status || 500
    return new Response(JSON.stringify({ message: errorMessage }), {
      status: errorCode
    })
  }
}
