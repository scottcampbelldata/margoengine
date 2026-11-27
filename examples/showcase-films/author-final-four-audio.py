"""Original stereo scores and picture-synced sound effects for the four showcase films."""
import sys
import wave
from pathlib import Path
import numpy as np

RATE = 48_000
LENGTH = 90
PROFILES = {
    'the-village-that-builds-itself': (81, 5461),
    'lantern-courier': (109, 9053),
    'the-voxel-night-shop': (78, 9235),
    'the-paper-aviary': (92, 7201),
}


class Mix:
    def __init__(self, seed):
        self.track = np.zeros((LENGTH * RATE, 2), np.float32)
        self.rng = np.random.default_rng(seed)

    def add(self, sound, start, gain, pan=0):
        sample = int(round(start * RATE))
        end = min(len(self.track), sample + len(sound))
        if end <= sample:
            return
        signal = sound[:end-sample] * gain
        self.track[sample:end, 0] += signal * np.sqrt((1-pan) * 0.5)
        self.track[sample:end, 1] += signal * np.sqrt((1+pan) * 0.5)

    def note(self, start, midi, duration, gain, pan, voice):
        seconds = np.arange(int(RATE * duration)) / RATE
        hz = 440 * 2**((midi - 69) / 12)
        phase = 2 * np.pi * hz * seconds
        if voice == 'wood':
            sound = sum(np.sin(phase * k) * a * np.exp(-seconds * d)
                        for k, a, d in [(1,1,2.6),(2,.34,8),(3,.19,12),(5,.075,18),(7,.035,26)])
            attack, release = .009, .28
        elif voice == 'pulse':
            sound = (.77*np.sin(phase) + .26*np.sin(phase*2) + .14*np.sin(phase*3)
                     + .06*np.sin(phase*5)) * np.exp(-seconds * 1.4)
            attack, release = .023, .19
        elif voice == 'electric':
            sound = (.69*np.sin(phase + .32*np.sin(phase*2)*np.exp(-seconds*8))
                     + .19*np.sin(phase*2.003) + .11*np.sin(phase*3.01)*np.exp(-seconds*4))
            sound *= (0.93 + .07*np.cos(2*np.pi*4.1*seconds))*np.exp(-seconds*1.73)
            attack, release = .016, .25
        else:
            sound = (.88*np.sin(phase) + .23*np.sin(phase*2.41)*np.exp(-seconds*4.9)
                     + .11*np.sin(phase*3.51)*np.exp(-seconds*8.0)
                     + .035*np.sin(phase*5.07)*np.exp(-seconds*17))*np.exp(-seconds*1.65)
            attack, release = .007, .30
        envelope = np.clip(seconds / attack, 0, 1)*np.clip((duration-seconds)/release, 0, 1)
        self.add(sound*envelope, start, gain, pan)
        if gain > 0.024:
            self.add(sound*envelope, start+.152, gain*.09, -pan*.6)
            self.add(sound*envelope, start+.299, gain*.041, pan*.62)

    def noise(self, duration, brightness):
        count = int(duration * RATE)
        raw = self.rng.standard_normal(count)
        frequency = np.fft.rfftfreq(count,1/RATE)
        envelope = (1-np.exp(-(frequency/(brightness*.24))**2))*np.exp(-(frequency/brightness)**2)
        noise = np.fft.irfft(np.fft.rfft(raw)*envelope, n=count)
        return noise/(np.std(noise)+1e-7)

    def bed(self, color, gain):
        t = np.arange(LENGTH * RATE) / RATE
        modulation = .66+.13*np.sin(t*.48)+.1*np.sin(t*.31+.8)+.07*np.sin(t*1.42)
        for pan in [-.65,.65]:
            self.add(self.noise(LENGTH, color)*modulation,0,gain,pan)

    def tick(self, start, gain, pan, mode):
        duration, color, decay, bass = {
            'stone':(.18,720,36,92), 'step':(.11,1220,61,118), 'kick':(.26,270,39,67),
            'relay':(.094,2800,86,210), 'paper':(.26,1650,15,0), 'wood':(.10,650,56,154),
        }[mode]
        seconds=np.arange(int(duration*RATE))/RATE
        attack=.022 if mode=='paper' else .0036
        signal=self.noise(duration,color)*np.exp(-seconds*decay)*np.clip(seconds/attack,0,1)*.39
        if bass:
            signal += np.sin(2*np.pi*bass*seconds)*np.exp(-seconds*decay*1.2)*.43
        self.add(signal,start,gain,pan)

    def write(self, destination):
        t=np.arange(len(self.track))/RATE
        fade=np.clip(t/.26,0,1)*np.clip((90-t)/1.15,0,1)
        audio=self.track*fade[:,None]
        audio /= max(.52, float(np.max(np.abs(audio)))/.87)
        with wave.open(str(destination), 'wb') as output:
            output.setparams((2,2,RATE,0,'NONE','not compressed'))
            output.writeframes(np.int16(np.clip(audio,-1,1)*32767).tobytes())


def village(m, beat):
    m.bed(445,.007)
    harmony=[[50,57,62,65,69],[46,53,60,62,65],[53,57,60,67,72],[48,55,60,64,67]]
    for bar in range(31):
        t = bar*beat*4
        chord=harmony[(bar//2)%4]
        if t>87:
            break
        m.note(t,chord[0]-12,1.32,.073,-.09,'wood')
        for i,key in enumerate([0,2,3,1,4,2]):
            m.note(t+i*beat*2/3,chord[key]+(12 if bar%4==3 and i>2 else 0),.64,
                   .075 if i in [0,3] else .051, .23 if i%2 else -.26,'wood')
        if 3<=bar<20:
            m.tick(t+beat*2,.052,.24,'wood')
            m.tick(t+beat*3.35,.032,-.3,'stone')
    for start in [0.57,30.54,55.54]:
        for i in range(10):
            m.tick(start+i*.143 + m.rng.uniform(0,.057),.051,-.68+i/7.5,'stone')


def courier(m, beat):
    m.bed(1630,.004)
    harmony=[[43,55,58,62,65],[46,53,58,62,67],[41,53,57,60,65],[48,55,60,63,67]]
    melody=[2,4,3,1,2,4,2,0]
    for bar in range(41):
        t=bar*beat*4
        chord=harmony[(bar//2)%4]
        for k in range(4):
            m.note(t+k*beat,chord[0]+(0 if k%3 else 12),.36,.081,-.12,'pulse')
            if k in (0,2): m.tick(t+k*beat,.085,0,'kick')
            if k in (1,3): m.tick(t+k*beat,.052,-.22,'relay')
        for i,key in enumerate(melody):
            m.note(t+beat*i/2,chord[key]+12,.28,.042 if i%4 else .062, -.28 if i%2 else .3,'pulse')
    intervals=[[0,84],[4.5,133],[13,238],[22,323],[28,323],[40,496],[52,678],
               [61,746],[66,771],[76,1007],[82,1096],[90,1096]]
    for (start,a),(end,b) in zip(intervals,intervals[1:]):
        if a==b: continue
        for index in range(int(a/2.85)+1, int(b/2.85)+1):
            if index%7 in (0,3):
                time=start+(end-start)*(index*2.85-a)/(b-a)
                m.tick(time,.020,-.07 if index%7 else .06,'step')
    for step,key in enumerate([67,70,74,81]):
        m.note(82+step*.14,key,.74,.083,.19,'pulse')


def shop(m, beat):
    m.bed(245,.008)
    chord_sequence=[[38,53,57,60,64],[43,53,57,59,62],[36,52,55,59,62],[45,55,60,64,67]]
    for bar in range(30):
        t=bar*beat*4
        chord=chord_sequence[(bar//2)%4]
        if t>86: break
        for r in [0,1.75,3]:
            m.note(t+beat*r,chord[0] + (12 if r==3 else 0),.81,.104,-.07,'electric')
        for d in [0,.67,2.18,3.5]:
            for i,key in enumerate(chord[1:]):
                m.note(t+beat*d+i*.023,key,1.07,.039,.46-i*.3,'electric')
        if bar>=3:
            m.tick(t,.095,0,'kick')
            m.tick(t+beat*2.62,.055,.32,'wood')
            m.tick(t+beat*3.5,.035,-.28,'relay')
    m.tick(.12,.12,.16,'relay')
    m.tick(5,.078,-.24,'relay')
    m.tick(11.6,.18,.27,'relay')
    m.tick(28.5,.15,-.35,'relay')
    for t in (11.6,28.5):
        seconds=np.arange(RATE*2)/RATE
        hum=(np.sin(2*np.pi*102*seconds)+.21*np.sin(2*np.pi*205*seconds))*(1-np.exp(-seconds*15))*np.exp(-seconds*2)
        m.add(hum,t,.032,.21)


def aviary(m, beat):
    m.bed(720,.0034)
    chords=[[55,62,67,71,74],[52,59,64,67,71],[48,55,62,64,69],[50,57,62,66,69]]
    phrase=[0,2,4,3,1,4,3,2]
    for bar in range(36):
        t=bar*beat*4
        chord=chords[(bar//2)%4]
        if t>87: break
        m.note(t,chord[0]-12,1.5,.077,-.19,'electric')
        for i,key in enumerate(phrase):
            if (bar%7==0 and i in (2,6)) or (bar<5 and i%3==1): continue
            m.note(t+i*beat/2,chord[key]+(12 if i in [2,5] and 10<bar<27 else 0),.80,.068 if i%3==0 else .043,
                   .42 if i%2==0 else -.34,'bell')
    for time in [1.1,2.3,3.18,14,17.3,22.4,26.9,29.6,80.8,81.9]:
        m.tick(time,.061,.06,'paper')
    for k in range(106):
        time=(k+.28)/1.28
        if 35.8<=time<=80.6:
            m.tick(time,.016+.017*np.sin(time*.47)**2,.49*np.sin(time*.19),'paper')


if __name__ == '__main__':
    film, out = sys.argv[1:]
    tempo, seed = PROFILES[film]
    mixer = Mix(seed)
    {'the-village-that-builds-itself':village,'lantern-courier':courier,
     'the-voxel-night-shop':shop,'the-paper-aviary':aviary}[film](mixer,60/tempo)
    path=Path(out)
    path.parent.mkdir(parents=True,exist_ok=True)
    mixer.write(path)
