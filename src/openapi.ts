export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Renault Reader API",
    version: "1.0.0",
    description: "API para generar y descargar exportaciones de ASMDOR.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local" }],
  tags: [
    { name: "System", description: "Estado del servicio" },
    { name: "Labours", description: "Exportaciones Labour Times TM01" },
     { name: "Parts", description: "Exportaciones de piezas y referencias de ASMDOR" },
  ],
  paths: {
    "/health": {
      get: {
        tags: ["System"],
        summary: "Comprueba que la API está disponible",
        responses: { "200": { description: "Servicio disponible", content: { "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } } } } },
      },
    },
    "/labours/options": {
      post: {
        tags: ["Labours"],
        summary: "Obtiene las opciones autorizadas para TM01",
        description: "Usa las credenciales RENAULT_EMAIL/RENAULT_PASSWORD del entorno, autentica contra Gigya y consulta las familias, formatos e idiomas permitidos por Renault.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LabourOptionsRequest" } } } },
        responses: {
          "200": { description: "Opciones autorizadas", content: { "application/json": { schema: { $ref: "#/components/schemas/LabourOptionsResponse" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },
    "/labours": {
      post: {
        tags: ["Labours"],
        summary: "Encola una exportación Labour Times",
        description: "Crea un job asíncrono usando exclusivamente las credenciales configuradas en el entorno.",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/LabourRequest" } } } },
        responses: {
          "202": { description: "Exportación encolada", content: { "application/json": { schema: { $ref: "#/components/schemas/QueuedResponse" } } } },
          "400": { $ref: "#/components/responses/BadRequest" },
        },
      },
    },
    "/labours/{requestId}": {
      get: {
        tags: ["Labours"],
        summary: "Consulta el estado de una exportación",
        parameters: [{ $ref: "#/components/parameters/RequestId" }],
        responses: {
          "200": { description: "Estado del job", content: { "application/json": { schema: { $ref: "#/components/schemas/LabourStatus" } } } },
          "404": { $ref: "#/components/responses/NotFound" },
        },
      },
    },
    "/labours/{requestId}/download": {
      get: {
        tags: ["Labours"],
        summary: "Descarga el ZIP de una exportación completada",
        parameters: [{ $ref: "#/components/parameters/RequestId" }],
        responses: {
          "307": { description: "Redirección temporal a una URL presignada de S3/MinIO" },
          "404": { $ref: "#/components/responses/NotFound" },
          "409": { description: "El ZIP todavía no está disponible", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
        },
      },
    },
    "/parts/options": {
      post: {
        tags: ["Parts"], summary: "Obtiene las opciones autorizadas para un export de Parts",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PartsOptionsRequest" } } } },
        responses: { "200": { description: "Opciones autorizadas", content: { "application/json": { schema: { $ref: "#/components/schemas/PartsOptionsResponse" } } } }, "400": { $ref: "#/components/responses/BadRequest" } },
      },
    },
    "/parts": {
      post: {
        tags: ["Parts"],
        summary: "Encola una exportación de Parts",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PartsRequest" } } } },
        responses: { "202": { description: "Exportación encolada", content: { "application/json": { schema: { $ref: "#/components/schemas/QueuedResponse" } } } }, "400": { $ref: "#/components/responses/BadRequest" } },
      },
    },
    "/parts/{requestId}": {
      get: {
        tags: ["Parts"], summary: "Consulta el estado de una exportación de Parts", parameters: [{ $ref: "#/components/parameters/RequestId" }],
        responses: { "200": { description: "Estado del job", content: { "application/json": { schema: { $ref: "#/components/schemas/LabourStatus" } } } }, "404": { $ref: "#/components/responses/NotFound" } },
      },
    },
    "/parts/{requestId}/download": {
      get: {
        tags: ["Parts"], summary: "Descarga un export de Parts completado", parameters: [{ $ref: "#/components/parameters/RequestId" }],
        responses: { "307": { description: "Redirección temporal a S3/MinIO" }, "404": { $ref: "#/components/responses/NotFound" }, "409": { description: "El archivo todavía no está disponible" } },
      },
    },
  },
  components: {
    parameters: {
      RequestId: { name: "requestId", in: "path", required: true, description: "Identificador UUID del job", schema: { type: "string", format: "uuid" } },
    },
    responses: {
      BadRequest: { description: "Petición inválida o error de validación", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
      NotFound: { description: "Recurso no encontrado", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } },
    },
    schemas: {
      HealthResponse: { type: "object", required: ["status"], properties: { status: { type: "string", example: "ok" } } },
      ErrorResponse: { type: "object", required: ["error"], properties: { error: { type: "string", example: "Labour file is not ready" }, status: { type: "string", nullable: true } } },
      AccionaLoadRequest: { type: "object", properties: { targetDatabase: { type: "string", example: "_MOK_MOK" }, confirmProduction: { type: "boolean", description: "Obligatorio para escribir fuera de _MOK_MOK" }, dryRun: { type: "boolean", description: "Calcula el volumen sin modificar la base" } } },
      LabourOptionsRequest: {
        type: "object",
        required: ["range"],
        properties: {
          range: { type: "string", example: "active" },
        },
      },
      PartsOptionsRequest: {
        type: "object", required: ["exportType", "range"], properties: {
          exportType: { type: "string", enum: ["REF01", "REF02", "REF03", "REF04", "REF05", "PR03", "PR05", "PR06", "PR08"] }, range: { type: "string", example: "active" },
        },
      },
      PartsOptionsResponse: {
        type: "object", required: ["queryCode", "profile", "range", "families", "formats", "languages"], properties: {
          queryCode: { type: "string", example: "PR08" }, queryDesc: { type: "string" }, profile: { type: "string" }, range: { type: "string" }, families: { type: "array", items: { $ref: "#/components/schemas/Family" } }, formats: { type: "array", items: { type: "string" } }, languages: { type: "array", nullable: true, items: { type: "string" } },
        },
      },
      PartsRequest: {
        type: "object", required: ["exportType", "range"], properties: {
          exportType: { type: "string", enum: ["REF01", "REF02", "REF03", "REF04", "REF05", "PR03", "PR05", "PR06", "PR08"] }, axCode: { type: "string", example: "5208" }, epc: { type: "string", example: "0826" }, manufacturer: { type: "string", example: "DACIA" }, description: { type: "string", example: "Bigster (SVA)" }, edition: { type: "string", pattern: "^\\d{2}/\\d$", example: "02/0" }, modelIds: { type: "array", items: { type: "string" }, description: "Modelos REF04 seleccionados; si se omite se procesan todos" }, family: { type: "string", example: "X1310" }, format: { type: "string", example: "zip" }, language: { type: "string", example: "en" }, range: { type: "string", example: "active" }, publishedAfter: { type: "string", format: "date" }, previousRequestId: { type: "string", format: "uuid", description: "RequestId de la edición REF05 anterior para generar hojas New/Deleted" }, illustrationsRequestId: { type: "string", format: "uuid" },
        },
      },
      LabourRequest: {
        type: "object",
        required: ["family", "format", "language", "range"],
        properties: {
          family: { type: "string", example: "All", description: "Debe ser un value autorizado por /labours/options" },
          format: { type: "string", example: "_json.zip", description: "Usa exactamente un valor devuelto por /labours/options, por ejemplo _json.zip o _csv.zip; no confundir con contentFormat" },
          language: { type: "string", example: "en" },
          range: { type: "string", example: "active" },
          publishedAfter: { type: "string", format: "date", example: "2026-05-01" },
        },
      },
      LabourOptionsResponse: {
        type: "object",
        required: ["queryCode", "profile", "range", "families", "formats", "languages"],
        properties: {
          queryCode: { type: "string", example: "TM01" },
          profile: { type: "string", example: "AUDATEX" },
          range: { type: "string", example: "active" },
          families: { type: "array", items: { $ref: "#/components/schemas/Family" } },
          formats: { type: "array", items: { type: "string" }, example: ["csv", "json"] },
          languages: { type: "array", nullable: true, items: { type: "string" }, example: ["en", "es"] },
        },
      },
      Family: {
        type: "object",
        required: ["label", "value"],
        properties: {
          label: { type: "string", example: "Clio" },
          value: { type: "string", example: "CLIO" },
          criteria: { type: "string", nullable: true, example: "All" },
          brand: { type: "string", nullable: true, example: "RENAULT" },
          ecuId: { type: "string", nullable: true },
        },
      },
      QueuedResponse: {
        type: "object",
        required: ["requestId", "status", "statusUrl"],
        properties: {
          requestId: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["queued"] },
          statusUrl: { type: "string", example: "/labours/550e8400-e29b-41d4-a716-446655440000" },
        },
      },
      LabourStatus: {
        type: "object",
        required: ["requestId", "status", "stage", "createdAt", "updatedAt"],
        properties: {
          requestId: { type: "string", format: "uuid" },
          status: { type: "string", enum: ["queued", "authenticating", "discovering", "validating", "checking_remote", "submitted", "waiting", "downloading", "uploading", "completed", "failed"] },
          stage: { type: "string" },
          progress: { type: "integer", nullable: true, minimum: 0, maximum: 100 },
          remoteRequestId: { type: "string", nullable: true },
          fileName: { type: "string", nullable: true },
           objectKey: { type: "string", nullable: true, example: "RENAULT_GROUP/files_datasource/RENAULT/Labour_Time/renault_<requestId>_<fileName>" },
           rawObjectKey: { type: "string", nullable: true },
           structuredKey: { type: "string", nullable: true },
           reportObjectKey: { type: "string", nullable: true },
          downloadUrl: { type: "string", nullable: true, example: "/labours/550e8400-e29b-41d4-a716-446655440000/download" },
          error: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;
