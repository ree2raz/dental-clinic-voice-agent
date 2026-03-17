const connectBtn = document.getElementById('connectBtn') as HTMLButtonElement | null;
const disconnectBtn = document.getElementById('disconnectBtn') as HTMLButtonElement | null;
const statusEl = document.getElementById('status') as HTMLDivElement | null;
const audioLevelEl = document.getElementById('audioLevel') as HTMLDivElement | null;

let ws: WebSocket | null = null;

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let workletNode: AudioWorkletNode | null = null;
let audioBufferQueue: Float32Array[] = [];
let isRecording = false;
let audioSendInterval: number | null = null;

let playbackContext: AudioContext | null = null;
let audioQueue: AudioBuffer[] = [];
let isPlaying = false;
let isResponseInProgress = false;
let pendingFunctionCall: { name: string; args: any } | null = null;

let totalAudioSent = 0;
let lastCommitTime = 0;

const State = {
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  GREETING: 'GREETING',
  COLLECT_NAME: 'COLLECT_NAME',
  COLLECT_REASON: 'COLLECT_REASON',
  SAVE_INTAKE: 'SAVE_INTAKE',
  ASK_TIME: 'ASK_TIME',
  VALIDATE_HOURS: 'VALIDATE_HOURS',
  CONFIRM_SLOT: 'CONFIRM_SLOT',
  BOOK_APPOINTMENT: 'BOOK_APPOINTMENT',
  SUMMARY: 'SUMMARY',
  CLOSING: 'CLOSING'
} as const;

type StateType = typeof State[keyof typeof State];

let currentState: StateType = State.DISCONNECTED;

// Tool call tracking for output validation
let toolsCalledInCurrentState: string[] = [];
let lastToolCallTime: number = 0;

// Canned responses for guardrail violations
const cannedResponses = {
  offTopic: "I'm here to help you with dental appointments and clinic information. How can I assist you with your dental care today?",
  schedulingInIntake: "I'd be happy to help you schedule an appointment. First, I need to collect some information. Could you please provide your full name and the reason for your visit?",
  hoursWithoutTool: "Let me check our availability for you. What day and time would work best for your appointment?",
  unauthorizedClaim: "I want to make sure I give you accurate information. Let me verify that for you.",
  interruptionRecovery: "I apologize, I didn't catch that. Could you please repeat what you were saying?",
  invalidTransition: "I'm not able to do that right now. Let me help you with the current step."
};

// Response validation rules per state
const stateValidationRules: Record<StateType, {
  forbiddenPatterns: RegExp[];
  requiredTools: string[];
  canMentionHours: boolean;
  canSchedule: boolean;
}> = {
  [State.DISCONNECTED]: {
    forbiddenPatterns: [],
    requiredTools: [],
    canMentionHours: false,
    canSchedule: false
  },
  [State.CONNECTING]: {
    forbiddenPatterns: [],
    requiredTools: [],
    canMentionHours: false,
    canSchedule: false
  },
  [State.GREETING]: {
    forbiddenPatterns: [/open\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)/i, /available\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend)/i],
    requiredTools: [],
    canMentionHours: false,
    canSchedule: false
  },
  [State.COLLECT_NAME]: {
    forbiddenPatterns: [/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(open|close|available)\b/i],
    requiredTools: [],
    canMentionHours: false,
    canSchedule: false
  },
  [State.COLLECT_REASON]: {
    forbiddenPatterns: [/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(open|close|available)\b/i, /book\s+(?:an?\s+)?appointment/i],
    requiredTools: [],
    canMentionHours: false,
    canSchedule: false
  },
  [State.SAVE_INTAKE]: {
    forbiddenPatterns: [/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(open|close|available)\b/i],
    requiredTools: ['save_intake_info'],
    canMentionHours: false,
    canSchedule: false
  },
  [State.ASK_TIME]: {
    forbiddenPatterns: [],
    requiredTools: [],
    canMentionHours: false,
    canSchedule: true
  },
  [State.VALIDATE_HOURS]: {
    forbiddenPatterns: [/we are open/i, /clinic is open/i, /available/i],
    requiredTools: ['check_business_hours'],
    canMentionHours: false,
    canSchedule: false
  },
  [State.CONFIRM_SLOT]: {
    forbiddenPatterns: [],
    requiredTools: ['check_business_hours'],
    canMentionHours: true,
    canSchedule: true
  },
  [State.BOOK_APPOINTMENT]: {
    forbiddenPatterns: [],
    requiredTools: ['book_appointment'],
    canMentionHours: true,
    canSchedule: true
  },
  [State.SUMMARY]: {
    forbiddenPatterns: [],
    requiredTools: ['book_appointment'],
    canMentionHours: true,
    canSchedule: true
  },
  [State.CLOSING]: {
    forbiddenPatterns: [],
    requiredTools: [],
    canMentionHours: true,
    canSchedule: true
  }
};
let previousState: StateType | null = null;
let patientName: string | null = null;
let visitReason: string | null = null;
let proposedDay: string | null = null;
let proposedTime: string | null = null;
let businessHoursValid = false;

interface StateConfig {
  instructions: string;
  tools: any[];
  allowedTransitions: StateType[];
  entryCondition: () => boolean;
  exitCondition: () => boolean;
}

const tools = [
  {
    type: 'function',
    name: 'save_intake_info',
    description: 'Saves the patient name and their reason for the visit into the clinic database.',
    parameters: {
      type: 'object',
      properties: {
        patientName: { type: 'string', description: 'The full name of the patient.' },
        visitReason: { type: 'string', description: 'A brief description of why the patient needs to visit the dentist.' }
      },
      required: ['patientName', 'visitReason']
    }
  },
  {
    type: 'function',
    name: 'check_business_hours',
    description: 'Checks if the dental clinic is open at a proposed requested day and time.',
    parameters: {
      type: 'object',
      properties: {
        dayOfWeek: { type: 'string', enum: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'], description: 'The day of the week requested.' },
        hour24: { type: 'number', description: 'The hour of the day in 24-hour format (e.g., 14 for 2 PM).' }
      },
      required: ['dayOfWeek', 'hour24']
    }
  },
  {
    type: 'function',
    name: 'book_appointment',
    description: 'Finalizes the booking of the appointment.',
    parameters: {
      type: 'object',
      properties: {
        dayOfWeek: { type: 'string' },
        time: { type: 'string' }
      },
      required: ['dayOfWeek', 'time']
    }
  }
];

const stateConfigs: Record<string, StateConfig> = {
  [State.DISCONNECTED]: {
    instructions: '',
    tools: [],
    allowedTransitions: [State.CONNECTING],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.CONNECTING]: {
    instructions: '',
    tools: [],
    allowedTransitions: [State.GREETING, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.GREETING]: {
    instructions: 'You are the Intake Agent (first point of contact) for the dental clinic. Your primary goal is to warmly greet the user, ask for their full name, and their reason for the dental visit. CRITICAL RULES: 1. You MUST call the save_intake_info function once the user provides their name and reason. 2. Do not proceed to scheduling without both pieces of information. If they ask to schedule immediately without giving info, politely insist on getting their name and reason first.',
    tools: [],
    allowedTransitions: [State.COLLECT_NAME, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.COLLECT_NAME]: {
    instructions: 'You are collecting the caller\'s name. CRITICAL RULES: 1. If they haven\'t provided their name, ask for it again. 2. Once you have their name, ask for their reason for the dental visit.',
    tools: [],
    allowedTransitions: [State.COLLECT_REASON, State.GREETING, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.COLLECT_REASON]: {
    instructions: 'You are collecting the caller\'s reason for visit. CRITICAL RULES: 1. Ask for the reason for their dental visit. 2. Once you have their reason, call save_intake_info. 3. Do not proceed to scheduling until save_intake_info succeeds.',
    tools: [tools[0]],
    allowedTransitions: [State.SAVE_INTAKE, State.COLLECT_NAME, State.GREETING, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.SAVE_INTAKE]: {
    instructions: 'Waiting for intake info to be saved. Once saved, you can proceed to scheduling.',
    tools: [],
    allowedTransitions: [State.ASK_TIME, State.COLLECT_REASON, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.ASK_TIME]: {
    instructions: 'You are helping the caller schedule an appointment. Your ONLY goal is to help the user find a time that works for them, verify it using the check_business_hours tool, and then book it using book_appointment. CRITICAL RULES: 1. NEVER guess or assume the clinic is open. You MUST use the check_business_hours tool for EVERY requested time. 2. If the tool says the clinic is closed, apologize and state our exact business hours: Monday to Friday, 9:00 AM to 5:00 PM. Tell the user we cannot book outside these hours. 3. Once an open time is agreed upon, use the book_appointment tool to finalize.',
    tools: [tools[1]],
    allowedTransitions: [State.VALIDATE_HOURS, State.SAVE_INTAKE, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.VALIDATE_HOURS]: {
    instructions: 'You are validating the proposed appointment time. Use the check_business_hours tool to verify if the clinic is open at the requested day and time.',
    tools: [tools[1]],
    allowedTransitions: [State.CONFIRM_SLOT, State.ASK_TIME, State.SAVE_INTAKE, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.CONFIRM_SLOT]: {
    instructions: 'You are confirming the appointment slot with the user. If the user confirms, use book_appointment. If they want a different time, go back to ASK_TIME. If they\'re ready to book, proceed.',
    tools: [tools[2]],
    allowedTransitions: [State.BOOK_APPOINTMENT, State.VALIDATE_HOURS, State.ASK_TIME, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.BOOK_APPOINTMENT]: {
    instructions: 'The appointment is being booked. Let the user know the appointment is confirmed. Say something like \"Your appointment is booked for [day] at [time]. We look forward to seeing you!\"',
    tools: [],
    allowedTransitions: [State.SUMMARY, State.CONFIRM_SLOT, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.SUMMARY]: {
    instructions: 'Summarize the appointment details for the user. Mention their name, reason for visit, and the booked appointment time. Thank them and let them know what to expect.',
    tools: [],
    allowedTransitions: [State.CLOSING, State.BOOK_APPOINTMENT, State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  },
  [State.CLOSING]: {
    instructions: 'Say goodbye to the caller. Keep it brief and friendly.',
    tools: [],
    allowedTransitions: [State.DISCONNECTED],
    entryCondition: () => true,
    exitCondition: () => true
  }
};

function updateStatus(status: string) {
  if (statusEl) statusEl.innerHTML = status;
  console.log(`[Status] ${status}`);
}

function logStateChange(newState: StateType, reason?: string) {
  previousState = currentState;
  currentState = newState;
  const reasonStr = reason ? `, Reason: ${reason}` : '';
  console.log(`[STATE] ${previousState} → ${newState}${reasonStr}`);
}

function logWebSocket(direction: 'Sent' | 'Received', type: string, details?: any) {
  const detailStr = details ? ` ${JSON.stringify(details).slice(0, 100)}` : '';
  console.log(`[WS] ${direction}: ${type}${detailStr}`);
}

function logVAD(event: string, details?: any) {
  const detailStr = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[VAD] ${event}${detailStr}`);
}

function logTransition(from: StateType, to: StateType, reason: string) {
  console.log(`[TRANSITION] ${from} → ${to}, Reason: ${reason}`);
}

function logAudio(event: string, details?: any) {
  const detailStr = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[AUDIO] ${event}${detailStr}`);
}

function logTool(name: string, phase: 'START' | 'DONE' | 'RESULT', data?: any) {
  const detailStr = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[TOOL_${phase}] ${name}${detailStr}`);
}

function logInterruption(details: string) {
  console.log(`[INTERRUPTION] ${details}`);
}

function logRollback(from: StateType, to: StateType, reason: string) {
  console.log(`[ROLLBACK] ${from} → ${to}, Reason: ${reason}`);
}

function logGuardrail(type: 'INPUT' | 'OUTPUT', event: string, details?: any) {
  const detailStr = details ? ` ${JSON.stringify(details)}` : '';
  console.log(`[GUARDRAIL_${type}] ${event}${detailStr}`);
}

function validateResponse(text: string, state: StateType): { valid: boolean; violation?: string; cannedResponse?: string } {
  const rules = stateValidationRules[state];
  
  if (!rules) {
    return { valid: true };
  }

  // Check forbidden patterns
  for (const pattern of rules.forbiddenPatterns) {
    if (pattern.test(text)) {
      logGuardrail('OUTPUT', 'Forbidden pattern detected', { state, pattern: pattern.toString(), text: text.slice(0, 50) });
      return { 
        valid: false, 
        violation: 'forbidden_pattern',
        cannedResponse: cannedResponses.unauthorizedClaim
      };
    }
  }

  // Check if mentioning hours without proper tool call
  if (!rules.canMentionHours) {
    const hoursPattern = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(open|close|available|hours)\b/i;
    if (hoursPattern.test(text)) {
      const hasCheckedHours = toolsCalledInCurrentState.includes('check_business_hours');
      if (!hasCheckedHours) {
        logGuardrail('OUTPUT', 'Hours mentioned without tool call', { state, text: text.slice(0, 50) });
        return { 
          valid: false, 
          violation: 'unauthorized_hours_claim',
          cannedResponse: cannedResponses.hoursWithoutTool
        };
      }
    }
  }

  // Check if attempting to schedule in non-scheduling state
  if (!rules.canSchedule) {
    const schedulingPattern = /\b(book|schedule)\b.*\b(appointment|time|slot)\b/i;
    if (schedulingPattern.test(text)) {
      logGuardrail('OUTPUT', 'Scheduling attempt in non-scheduling state', { state, text: text.slice(0, 50) });
      return { 
        valid: false, 
        violation: 'unauthorized_scheduling',
        cannedResponse: cannedResponses.schedulingInIntake
      };
    }
  }

  return { valid: true };
}

function resetToolTracking() {
  toolsCalledInCurrentState = [];
  lastToolCallTime = 0;
}

function recordToolCall(toolName: string) {
  toolsCalledInCurrentState.push(toolName);
  lastToolCallTime = Date.now();
  logGuardrail('OUTPUT', 'Tool call recorded', { tool: toolName, state: currentState });
}

function redirectOffTopic(): string {
  logGuardrail('INPUT', 'Off-topic redirect triggered', { state: currentState });
  return cannedResponses.offTopic;
}

const audioWorkletCode = `
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0]) {
      this.port.postMessage({
        audioData: input[0].slice()
      });
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    const pcmValue = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, pcmValue, true);
  }
  return buffer;
}

function base64EncodeAudio(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64DecodeAudio(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function pcm16ToFloat32(pcmData: ArrayBuffer): Float32Array {
  const dataView = new DataView(pcmData);
  const float32Array = new Float32Array(pcmData.byteLength / 2);
  for (let i = 0; i < float32Array.length; i++) {
    const int16 = dataView.getInt16(i * 2, true);
    float32Array[i] = int16 / 0x8000;
  }
  return float32Array;
}

async function startAudioCapture() {
  try {
    logAudio('Requesting microphone access...');
    
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 24000,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    logAudio('Microphone access granted');

    audioContext = new AudioContext({
      sampleRate: 24000
    });

    logAudio(`Audio context created, sample rate: ${audioContext.sampleRate}`);

    const blob = new Blob([audioWorkletCode], { type: 'application/javascript' });
    const workletUrl = URL.createObjectURL(blob);
    
    await audioContext.audioWorklet.addModule(workletUrl);
    
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
    
    let currentAudioLevel = 0;
    workletNode.port.onmessage = (event) => {
      if (!isRecording) return;
      
      const audioData = event.data.audioData;
      if (audioData && audioData.length > 0) {
        let sum = 0;
        for (let i = 0; i < audioData.length; i++) {
          sum += Math.abs(audioData[i]);
        }
        currentAudioLevel = sum / audioData.length;
        
        if (audioLevelEl) {
          const percentage = Math.min(100, currentAudioLevel * 500);
          audioLevelEl.style.width = percentage + '%';
        }
        
        audioBufferQueue.push(audioData);
        
        if (audioBufferQueue.length % 5 === 0) {
          logAudio('Audio level', { 
            level: currentAudioLevel.toFixed(4),
            bufferSize: audioBufferQueue.reduce((sum, arr) => sum + arr.length, 0)
          });
        }
      }
    };

    sourceNode.connect(workletNode);
    
    isRecording = true;
    audioBufferQueue = [];
    totalAudioSent = 0;
    lastCommitTime = Date.now();
    
    audioSendInterval = window.setInterval(() => {
      if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
      
      if (audioBufferQueue.length === 0) return;
      
      const chunksToSend = [...audioBufferQueue];
      audioBufferQueue = [];
      
      const totalLength = chunksToSend.reduce((sum, arr) => sum + arr.length, 0);
      const combinedBuffer = new Float32Array(totalLength);
      let offset = 0;
      
      for (const buffer of chunksToSend) {
        combinedBuffer.set(buffer, offset);
        offset += buffer.length;
      }
      
      const pcmData = floatTo16BitPCM(combinedBuffer);
      const base64Audio = base64EncodeAudio(pcmData);
      
      if (base64Audio.length > 0) {
        ws.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: base64Audio
        }));
        
        totalAudioSent += combinedBuffer.length;
        lastCommitTime = Date.now();
        
        if (totalAudioSent % 24000 < 128) {
          logWebSocket('Sent', 'input_audio_buffer.append', { 
            bytes: base64Audio.length, 
            samples: combinedBuffer.length,
            totalSeconds: (totalAudioSent / 24000).toFixed(2)
          });
        }
      }
    }, 200);  // Send every 200ms
    
    logAudio('Microphone capture started');
  } catch (err) {
    logAudio('Failed to start capture', err);
    updateStatus('Error: Microphone access denied or audio init failed');
  }
}

function stopAudioCapture() {
  logAudio('Stopping capture...');
  isRecording = false;
  
  if (audioSendInterval) {
    clearInterval(audioSendInterval);
    audioSendInterval = null;
  }
  
  if (workletNode) {
    workletNode.disconnect();
    workletNode = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  audioBufferQueue = [];
  logAudio('Microphone capture stopped');
}

async function playAudioChunk(base64Audio: string) {
  try {
    logAudio('Playing chunk', { length: base64Audio.length });

    if (!playbackContext) {
      playbackContext = new AudioContext({ sampleRate: 24000 });
      logAudio('Created new playback context');
    }

    if (playbackContext.state === 'suspended') {
      logAudio('Resuming suspended context');
      await playbackContext.resume();
    }

    const pcmData = base64DecodeAudio(base64Audio);
    const float32Data = pcm16ToFloat32(pcmData);

    let maxAmp = 0;
    for (let i = 0; i < float32Data.length; i++) {
      maxAmp = Math.max(maxAmp, Math.abs(float32Data[i]));
    }
    logAudio('Chunk amplitude', { max: maxAmp.toFixed(4) });

    const audioBuffer = playbackContext.createBuffer(1, float32Data.length, 24000);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < float32Data.length; i++) {
      channelData[i] = float32Data[i];
    }

    audioQueue.push(audioBuffer);
    logAudio('Queued buffer', { queueLength: audioQueue.length });

    if (!isPlaying) {
      playNextChunk();
    }
  } catch (err) {
    logAudio('Error playing chunk', err);
  }
}

function playNextChunk() {
  if (!playbackContext || audioQueue.length === 0) {
    isPlaying = false;
    isResponseInProgress = false;
    updateStatus(`Connected. State: ${currentState}`);
    logAudio('Playback complete');
    return;
  }

  isPlaying = true;
  updateStatus(`AI speaking... (${currentState})`);
  
  const buffer = audioQueue.shift()!;
  logAudio('Playing chunk', { duration: buffer.duration.toFixed(2) + 's' });

  const source = playbackContext.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackContext.destination);

  source.onended = () => {
    playNextChunk();
  };

  source.start();
  logAudio('Started playback');
}

function stopAudioPlayback() {
  audioQueue = [];
  isPlaying = false;
  if (playbackContext) {
    playbackContext.close();
    playbackContext = null;
  }
}

function classifyInput(text: string): 'dental' | 'off-topic' | 'scheduling' {
  const lowerText = text.toLowerCase();

  const offTopicKeywords = ['weather', 'news', 'stock', 'sports', 'politics', 'movie', 'game', 'joke', 'music', 'recipe'];
  const schedulingKeywords = ['book', 'schedule', 'appointment', 'time', 'when', 'day', 'available', 'open'];

  if (offTopicKeywords.some(keyword => lowerText.includes(keyword))) {
    return 'off-topic';
  }
  if (schedulingKeywords.some(keyword => lowerText.includes(keyword))) {
    return 'scheduling';
  }
  
  return 'dental';
}

async function executeTool(name: string, args: any): Promise<string> {
  logTool(name, 'START');
  
  pendingFunctionCall = { name, args };
  
  // Record that this tool was called for output validation
  recordToolCall(name);
  
  if (name === 'save_intake_info') {
    console.log(`[DB] Saved Intake Info: Name=${args.patientName}, Reason=${args.visitReason}`);
    logTool(name, 'RESULT', { patientName: args.patientName, visitReason: args.visitReason });
    
    patientName = args.patientName;
    visitReason = args.visitReason;
    
    return `Successfully saved intake info for ${args.patientName} regarding: ${args.visitReason}.`;
  } else if (name === 'check_business_hours') {
    console.log(`[DB] Checking hours for ${args.dayOfWeek} at ${args.hour24}:00`);
    logTool(name, 'RESULT', { day: args.dayOfWeek, hour: args.hour24 });
    
    const isWeekday = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].includes(args.dayOfWeek);
    const isWorkingHour = args.hour24 >= 9 && args.hour24 < 17;

    if (isWeekday && isWorkingHour) {
      businessHoursValid = true;
      proposedDay = args.dayOfWeek;
      const timeStr = args.hour24 > 12 ? `${args.hour24 - 12}:00 PM` : `${args.hour24}:00 AM`;
      proposedTime = timeStr;
      console.log(`[DB] Hours valid: ${args.dayOfWeek} at ${args.hour24}:00`);
      return `Yes, the clinic is OPEN on ${args.dayOfWeek} at ${args.hour24}:00. You may proceed to book this slot.`;
    } else {
      businessHoursValid = false;
      console.log(`[DB] Hours invalid: ${args.dayOfWeek} at ${args.hour24}:00`);
      return `No, the clinic is CLOSED. Business hours are Monday to Friday, 9:00 AM to 5:00 PM. Tell the user we cannot book outside these hours.`;
    }
  } else if (name === 'book_appointment') {
    console.log(`[DB] Appointment Booked: ${args.dayOfWeek} at ${args.time}`);
    logTool(name, 'RESULT', { day: args.dayOfWeek, time: args.time });
    
    return `Appointment successfully booked for ${args.dayOfWeek} at ${args.time}.`;
  } else {
    logTool(name, 'DONE', { result: 'Unknown tool' });
    return 'Unknown tool';
  }
}

function transitionState(newState: StateType, reason: string) {
  const config = stateConfigs[currentState];

  if (!config.allowedTransitions.includes(newState)) {
    logGuardrail('OUTPUT', `Invalid transition blocked: ${currentState} → ${newState}`, { reason: 'Not in allowed transitions' });
    return false;
  }

  const newConfig = stateConfigs[newState];
  if (!newConfig.entryCondition()) {
    logGuardrail('OUTPUT', `Transition blocked: ${currentState} → ${newState}`, { reason: 'Entry condition not met' });
    return false;
  }

  logTransition(currentState, newState, reason);

  previousState = currentState;
  currentState = newState;
  
  // Reset tool tracking for new state
  resetToolTracking();
  logGuardrail('OUTPUT', 'Tool tracking reset for new state', { state: newState });

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: newConfig.instructions,
        tools: newConfig.tools,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 2000
            }
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 }
          }
        }
      }
    }));
    logWebSocket('Sent', 'session.update', { state: newState, toolsCount: newConfig.tools.length });
  }

  updateStatus(`Connected. State: ${currentState}`);
  return true;
}

function handleInterruption() {
  logInterruption(`User interrupted during ${currentState} state`);

  if (isResponseInProgress) {
    isResponseInProgress = false;
    
    if (pendingFunctionCall) {
      logInterruption(`Function call was in progress: ${pendingFunctionCall.name}`);
      pendingFunctionCall = null;
    }

    // Cancel any in-progress response
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'response.cancel'
      }));
      logWebSocket('Sent', 'response.cancel', { reason: 'user_interruption' });
    }

    // Clear all audio buffers
    audioQueue = [];
    audioBufferQueue = [];
    
    // Stop any playing audio
    if (isPlaying && playbackContext) {
      try {
        playbackContext.suspend();
        logAudio('Audio context suspended due to interruption');
      } catch (e) {
        logAudio('Error suspending audio context', e);
      }
    }
    isPlaying = false;
    
    logAudio('All audio buffers cleared', { 
      audioQueueLength: 0, 
      audioBufferQueueLength: 0 
    });

    // Rollback to previous safe state
    const rollbackState = determineRollbackState(currentState);
    if (rollbackState !== currentState) {
      logRollback(currentState, rollbackState, 'User interrupted');
      transitionState(rollbackState, 'Interruption - user cut off AI');
      
      // Inject recovery message
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'input_text', text: cannedResponses.interruptionRecovery }]
          }
        }));
        logWebSocket('Sent', 'conversation.item.create', { type: 'interruption_recovery' });
        
        ws.send(JSON.stringify({
          type: 'response.create'
        }));
        logWebSocket('Sent', 'response.create', { reason: 'interruption_recovery' });
      }
    }
  }
}

function determineRollbackState(currentState: StateType): StateType {
  switch (currentState) {
    case State.BOOK_APPOINTMENT:
      return State.CONFIRM_SLOT;
    case State.CONFIRM_SLOT:
      return State.VALIDATE_HOURS;
    case State.VALIDATE_HOURS:
      return State.ASK_TIME;
    case State.ASK_TIME:
      return State.SAVE_INTAKE;
    case State.SAVE_INTAKE:
      return State.COLLECT_REASON;
    case State.COLLECT_REASON:
      return State.COLLECT_NAME;
    case State.COLLECT_NAME:
      return State.GREETING;
    case State.SUMMARY:
      return State.CLOSING;
    case State.CLOSING:
      return State.DISCONNECTED;
    default:
      return currentState;
  }
}

async function fetchToken(): Promise<string> {
  const response = await fetch('/api/token');
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch token: ${text}`);
  }
  const data = await response.json();
  return data.value;
}

async function connect() {
  if (connectBtn) connectBtn.disabled = true;
  updateStatus('Connecting...');
  logStateChange(State.CONNECTING);

  try {
    const token = await fetchToken();
    const url = 'wss://api.openai.com/v1/realtime';

    ws = new WebSocket(url, [
      'realtime',
      `openai-insecure-api-key.${token}`
    ]);

    ws.onopen = () => {
      updateStatus('Connected. Initializing...');
      console.log('[WS] Connected to WebSocket');
      if (disconnectBtn) disconnectBtn.disabled = false;

      const config = stateConfigs[State.GREETING];
      ws!.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: config.instructions,
          tools: config.tools,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 2000
              }
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 }
            }
          }
        }
      }));
      logWebSocket('Sent', 'session.update', { state: State.GREETING });
    };

    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      logWebSocket('Received', msg.type, msg.type === 'error' ? msg : undefined);

      switch (msg.type) {
        case 'session.created':
          console.log('Session created:', msg.session);
          break;

        case 'session.updated':
          console.log('Session updated successfully');
          await startAudioCapture();
          logStateChange(State.GREETING);
          updateStatus(`Connected. State: ${currentState}`);
          break;

        case 'input_audio_buffer.speech_started':
          logVAD('Speech started', msg);
          if (isResponseInProgress) {
            handleInterruption();
          }
          updateStatus('Listening...');
          break;

        case 'input_audio_buffer.speech_stopped':
          logVAD('Speech stopped', msg);
          updateStatus('Processing...');
          break;

        case 'input_audio_buffer.committed':
          logVAD('Audio committed', msg);
          break;

        case 'conversation.item.created':
          console.log('Item created:', msg.item);

          if (msg.item.type === 'message' && msg.item.role === 'user') {
            const content = msg.item.content?.[0]?.text || '';
            logGuardrail('INPUT', 'User message', { text: content.slice(0, 50) });

            const intent = classifyInput(content);
            logGuardrail('INPUT', 'Intent classified', { intent });

            if (intent === 'off-topic') {
              logGuardrail('INPUT', 'Off-topic detected - injecting redirect', { text: content.slice(0, 50) });
              
              // Inject canned response for off-topic
              const redirectMessage = redirectOffTopic();
              ws!.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'input_text', text: redirectMessage }]
                }
              }));
              logWebSocket('Sent', 'conversation.item.create', { type: 'off_topic_redirect' });
              
              // Trigger response creation
              ws!.send(JSON.stringify({
                type: 'response.create'
              }));
              logWebSocket('Sent', 'response.create', { reason: 'off_topic_redirect' });
            }
          }
          break;

        case 'response.created':
          console.log('Response created');
          isResponseInProgress = true;
          break;

        case 'response.output_item.added':
          console.log('Output item added:', msg.item);
          
          if (msg.item.type === 'message' && msg.item.content && msg.item.content.length > 0) {
            const firstContent = msg.item.content[0];
            
            // Validate text content before allowing audio playback
            if (firstContent.type === 'text' || firstContent.type === 'input_text') {
              const text = firstContent.text || '';
              const validation = validateResponse(text, currentState);
              
              if (!validation.valid) {
                logGuardrail('OUTPUT', 'Response blocked - injecting canned message', { 
                  violation: validation.violation,
                  originalText: text.slice(0, 50)
                });
                
                // Cancel the current response
                ws!.send(JSON.stringify({
                  type: 'response.cancel'
                }));
                logWebSocket('Sent', 'response.cancel', { reason: 'guardrail_violation' });
                
                // Inject canned response instead
                ws!.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'input_text', text: validation.cannedResponse || cannedResponses.unauthorizedClaim }]
                  }
                }));
                logWebSocket('Sent', 'conversation.item.create', { type: 'canned_response' });
                
                // Create new response with canned message
                ws!.send(JSON.stringify({
                  type: 'response.create'
                }));
                logWebSocket('Sent', 'response.create', { reason: 'canned_response' });
                
                // Don't play the invalid audio
                break;
              }
            }
            
            if (firstContent.type === 'output_audio' && firstContent.audio) {
              logAudio('Output item has audio, playing...');
              playAudioChunk(firstContent.audio);
            }
          }
          break;

        case 'response.function_call_arguments.delta':
          console.log('Function call delta:', msg.name, msg.delta);
          break;

        case 'response.function_call_arguments.done':
          console.log('Function call done:', msg.name);
          const args = JSON.parse(msg.arguments);
          const result = await executeTool(msg.name, args);

          ws!.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: msg.call_id,
              output: result
            }
          }));
          logWebSocket('Sent', 'conversation.item.create', { type: 'function_call_output' });

          ws!.send(JSON.stringify({
            type: 'response.create'
          }));
          logWebSocket('Sent', 'response.create');

          if (msg.name === 'save_intake_info') {
            if (!transitionState(State.SAVE_INTAKE, 'Intake info saved')) {
              transitionState(State.COLLECT_REASON, 'Intake info saved');
            }
          } else if (msg.name === 'check_business_hours') {
            if (businessHoursValid) {
              transitionState(State.CONFIRM_SLOT, 'Hours validated as open');
            } else {
              transitionState(State.VALIDATE_HOURS, 'Hours validated as closed');
            }
          } else if (msg.name === 'book_appointment') {
            transitionState(State.BOOK_APPOINTMENT, 'Appointment booked');
          }
          break;

        case 'response.output_item.done':
          console.log('Output item done:', msg.item);
          break;

        case 'response.done':
          console.log('Response done');
          isResponseInProgress = false;
          pendingFunctionCall = null;

          if (currentState === State.BOOK_APPOINTMENT) {
            transitionState(State.SUMMARY, 'Booking complete');
          } else if (currentState === State.SUMMARY) {
            transitionState(State.CLOSING, 'Summary complete');
          }
          break;

        case 'rate_limits.updated':
          console.log('[RATE_LIMIT] Rate limits:', msg);
          if (msg.rate_limits) {
            msg.rate_limits.forEach((limit: any) => {
              console.log(`[RATE_LIMIT] ${limit.name}: ${limit.limit} used, ${limit.remaining} remaining`);
            });
          }
          updateStatus(`Rate limited. Wait ${msg.rate_limits?.[0]?.reset_seconds}s...`);
          break;

        case 'error':
          console.error('[ERROR] Server error:', msg.error);
          console.error('[ERROR] Error details:', JSON.stringify(msg.error, null, 2));
          updateStatus(`Error: ${msg.error.message}`);
          
          console.error('[ERROR] Current state:', currentState);
          console.error('[ERROR] Total audio sent:', totalAudioSent, 'samples');
          console.error('[ERROR] Audio sent samples:', totalAudioSent / 24000, 'seconds');
          console.error('[ERROR] Last commit:', new Date(lastCommitTime).toISOString());
          console.error('[ERROR] Time since last commit:', (Date.now() - lastCommitTime), 'ms');
          break;
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket Error:', err);
      updateStatus('WebSocket error');
    };

    ws.onclose = () => {
      console.log('WebSocket closed');
      stopAudioCapture();
      stopAudioPlayback();
      logStateChange(State.DISCONNECTED);
      updateStatus('Disconnected');
      if (connectBtn) connectBtn.disabled = false;
      if (disconnectBtn) disconnectBtn.disabled = true;
    };

  } catch (err: any) {
    console.error('Connection failed:', err);
    updateStatus(`Connection failed: ${err.message}`);
    logStateChange(State.DISCONNECTED);
    if (connectBtn) connectBtn.disabled = false;
  }
}

async function disconnect() {
  if (disconnectBtn) disconnectBtn.disabled = true;
  updateStatus('Disconnecting...');
  logStateChange(State.DISCONNECTED);

  try {
    stopAudioCapture();
    stopAudioPlayback();
    if (ws) {
      ws.close();
      ws = null;
    }
    updateStatus('Disconnected');
  } catch (err: any) {
    console.error('Disconnection failed', err);
    updateStatus(`Disconnection failed: ${err.message}`);
  } finally {
    if (connectBtn) connectBtn.disabled = false;
    if (disconnectBtn) disconnectBtn.disabled = true;
  }
}

function sendTestTone() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('[TEST] WebSocket not connected');
    return;
  }

  const sampleRate = 24000;
  const duration = 1.0;
  const frequency = 440;
  const numSamples = Math.floor(sampleRate * duration);
  
  const float32Array = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    float32Array[i] = 0.5 * Math.sin(2 * Math.PI * frequency * t);
  }

  logAudio('Test tone generated', {
    samples: numSamples,
    frequency,
    duration: duration + 's',
    firstSample: float32Array[0],
    lastSample: float32Array[numSamples - 1]
  });

  const pcmData = floatTo16BitPCM(float32Array);
  const base64Audio = base64EncodeAudio(pcmData);

  logAudio('Test tone converted', {
    bytes: base64Audio.length,
    pcmBytes: pcmData.byteLength
  });

  ws.send(JSON.stringify({
    type: 'input_audio_buffer.append',
    audio: base64Audio
  }));

  logAudio('Test tone sent', {
    samples: numSamples,
    frequency,
    durationSeconds: duration.toFixed(2),
    bytes: base64Audio.length
  });

  console.log('[TEST] Test tone sent. Server should process it and respond');
  console.log('[TEST] You should hear the AI response (if working)');
}

function playTestTone() {
  if (!playbackContext) {
    playbackContext = new AudioContext({ sampleRate: 24000 });
  }

  if (playbackContext.state === 'suspended') {
    playbackContext.resume();
  }

  const sampleRate = 24000;
  const duration = 1.0;
  const frequency = 440;
  const numSamples = Math.floor(sampleRate * duration);

  const float32Array = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    float32Array[i] = 0.5 * Math.sin(2 * Math.PI * frequency * t);
  }

  const audioBuffer = playbackContext.createBuffer(1, numSamples, 24000);
  const channelData = audioBuffer.getChannelData(0);
  for (let i = 0; i < float32Array.length; i++) {
    channelData[i] = float32Array[i];
  }

  const source = playbackContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackContext.destination);
  source.start();

  logAudio('Test tone playing locally', {
    frequency,
    duration: duration + 's'
  });

  console.log('[TEST] Playing test tone. You should hear a 440Hz tone.');
}

if (connectBtn) {
  connectBtn.addEventListener('click', connect);
}

if (disconnectBtn) {
  const commitBtn = document.createElement('button');
  commitBtn.id = 'commitBtn';
  commitBtn.textContent = 'Commit Audio';
  commitBtn.style.backgroundColor = '#28a745';
  disconnectBtn.parentNode?.insertBefore(commitBtn, disconnectBtn);

  commitBtn.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'input_audio_buffer.commit'
      }));
      logWebSocket('Sent', 'input_audio_buffer.commit', { manual: true, note: 'Manual commit for testing' });
    }
  });
}

if (disconnectBtn) {
  const testBtn = document.createElement('button');
  testBtn.id = 'testBtn';
  testBtn.textContent = 'Send Test Tone';
  testBtn.style.backgroundColor = '#ffc107';
  testBtn.style.color = '#000';
  disconnectBtn.parentNode?.insertBefore(testBtn, disconnectBtn);

  testBtn.addEventListener('click', sendTestTone);
}

if (disconnectBtn) {
  const playTestBtn = document.createElement('button');
  playTestBtn.id = 'playTestBtn';
  playTestBtn.textContent = 'Play Test Tone';
  playTestBtn.style.backgroundColor = '#17a2b8';
  disconnectBtn.parentNode?.insertBefore(playTestBtn, disconnectBtn);

  playTestBtn.addEventListener('click', playTestTone);
}

console.log('[INIT] Raw WebSocket Voice Agent initialized');
console.log('[INIT] State machine ready with states:', Object.values(State).join(', '));
console.log('[INIT] Audio processing: Disabled echo cancellation, noise suppression, auto gain control');
console.log('[INIT] Send interval: 200ms for real-time audio');
console.log('[TEST] Test buttons added: "Send Test Tone", "Play Test Tone", "Commit Audio"');
console.log('[INIT] Use these to test audio pipeline without microphone');
