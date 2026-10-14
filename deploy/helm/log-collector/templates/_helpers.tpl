{{- define "log-collector.labels" -}}
app.kubernetes.io/name: log-collector
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "log-collector.selectorLabels" -}}
app.kubernetes.io/name: log-collector
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
The Alloy pipeline: find pods, label their lines, tail them, push to Loki.

The address and both credentials are read from the environment, so nothing
secret is rendered into the ConfigMap.
*/}}
{{- define "log-collector.config" -}}
discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets
{{- with .Values.excludeNamespaces }}

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    regex         = {{ join "|" . | quote }}
    action        = "drop"
  }
{{- end }}

  // Not its own output: a failed push is logged, and collecting that line
  // would turn one failure into a stream of them.
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
    regex         = "log-collector"
    action        = "drop"
  }

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }

  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
    target_label  = "app"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.process.levels.receiver]
}

// Gives each line a `level`. Grafana guesses one from the text when there is
// none, and it does not know NestJS's word for an ordinary line, LOG, so every
// such line would be shown as "unknown". MongoDB's one-letter severity is read
// the same way. A line in neither format, such as the continuation of a stack
// trace, is passed on untouched.
loki.process "levels" {
  forward_to = [loki.write.grafana_cloud.receiver]

  stage.regex {
    expression = "^\\[Nest\\]\\s+\\d+\\s+-\\s+.*?\\s+(?P<nest_level>LOG|WARN|ERROR|DEBUG|VERBOSE|FATAL)\\s+"
  }

  stage.regex {
    expression = "^\\{\"t\":\\{\"\\$date\":\"[^\"]+\"\\},\"s\":\"(?P<mongo_level>[IWEFD])"
  }

  stage.template {
    source   = "level"
    template = {{ `"{{ if .nest_level }}{{ if eq .nest_level \"LOG\" }}info{{ else if eq .nest_level \"VERBOSE\" }}trace{{ else if eq .nest_level \"FATAL\" }}critical{{ else }}{{ ToLower .nest_level }}{{ end }}{{ else if .mongo_level }}{{ if eq .mongo_level \"I\" }}info{{ else if eq .mongo_level \"W\" }}warn{{ else if eq .mongo_level \"E\" }}error{{ else if eq .mongo_level \"F\" }}critical{{ else }}debug{{ end }}{{ end }}"` }}
  }

  stage.labels {
    values = {
      level = "",
    }
  }
}

loki.write "grafana_cloud" {
  endpoint {
    url = sys.env("LOKI_URL") + "/loki/api/v1/push"

    basic_auth {
      username = sys.env("LOKI_USER")
      password = sys.env("LOKI_TOKEN")
    }
  }

  external_labels = {
    cluster = {{ .Values.cluster | quote }},
  }
}
{{- end -}}
