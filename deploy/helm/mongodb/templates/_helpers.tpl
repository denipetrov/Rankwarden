{{- define "mongodb.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "mongodb.labels" -}}
app.kubernetes.io/name: mongodb
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "mongodb.selectorLabels" -}}
app.kubernetes.io/name: mongodb
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* The in-cluster address every client uses. */}}
{{- define "mongodb.host" -}}
{{ .Release.Name }}.{{ .Release.Namespace }}.svc.cluster.local:27017
{{- end -}}

{{/* Restricted pod settings shared by the chart's Jobs. */}}
{{- define "mongodb.jobSecurity" -}}
runAsNonRoot: true
runAsUser: 999
runAsGroup: 999
fsGroup: 999
seccompProfile:
  type: RuntimeDefault
{{- end -}}
