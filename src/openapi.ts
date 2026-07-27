export const openapi = {
  openapi: "3.0.3",
  info: {
    title: "Renault Reader API",
    version: "1.0.0",
    description: "API para generar y descargar exportaciones Labour Times de ASMDOR.",
  },
  servers: [{ url: "http://localhost:3000", description: "Local" }],
  tags: [
    { name: "System", description: "Estado del servicio" },
    { name: "Labours", description: "Exportaciones Labour Times TM01" },
    { name: "Parts", description: "Endpoints reservados para Parts" },
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
    "/parts": {
      post: {
        tags: ["Parts"],
        summary: "Placeholder para Parts",
        responses: { "501": { description: "Parts todavía no está implementado", content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } } } },
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
      LabourOptionsRequest: {
        type: "object",
        required: ["range"],
        properties: {
          range: { type: "string", example: "active" },
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
          downloadUrl: { type: "string", nullable: true, example: "/labours/550e8400-e29b-41d4-a716-446655440000/download" },
          error: { type: "string", nullable: true },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
} as const;
