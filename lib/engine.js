function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
var GREEK=['Alpha','Beta','Gamma','Delta','Epsilon','Zeta'];
var SYSTEMS=['Centauri','Eridani','Cygni','Draconis','Lyrae','Orionis','Tauri','Hydri','Ceti','Persei','Aquilae','Pegasi','Carinae','Vela'];
var PALETTE=['#d98c5f','#7fb7e6','#c9c3b6','#b3d39a','#e3c36e','#9f8fd6','#e08aa8','#8ad0c8'];
function makeWorld(seed){
  var rnd=mulberry32(seed>>>0);
  var sun={mass:1,radius:0.06};
  var systemName=SYSTEMS[Math.floor(rnd()*SYSTEMS.length)];
  var n=4+(rnd()<0.5?0:1);
  var bodies=[],R=0.9+rnd()*0.3,DENSITY=100;
  var colors=PALETTE.slice();
  for(var k=0;k<n;k++){
    var radius=0.012+rnd()*0.022;
    var mass=DENSITY*radius*radius*radius;
    var omega=Math.sqrt(sun.mass/(R*R*R));
    var ci=Math.floor(rnd()*colors.length),color=colors.splice(ci,1)[0];
    bodies.push({name:GREEK[k],mass:+mass.toPrecision(4),radius:+radius.toFixed(4),orbitR:+R.toFixed(3),omega:omega,angle0:rnd()*Math.PI*2,period:2*Math.PI/omega,hill:R*Math.cbrt(mass/(3*sun.mass)),color:color});
    R*=1.6+rnd()*0.5;
  }
  var st=Math.floor(rnd()*n),tg=Math.floor(rnd()*(n-1));if(tg>=st)tg++;
  var A=bodies[st],B=bodies[tg];
  var a=(A.orbitR+B.orbitR)/2,tH=Math.PI*Math.sqrt(a*a*a/sun.mass);
  var v1=Math.sqrt(sun.mass/A.orbitR),v2=Math.sqrt(sun.mass/B.orbitR);
  var dv1=Math.abs(v1*(Math.sqrt(2*B.orbitR/(A.orbitR+B.orbitR))-1));
  var dv2=Math.abs(v2*(1-Math.sqrt(2*A.orbitR/(A.orbitR+B.orbitR))));
  var vescA=Math.sqrt(2*A.mass/A.radius),vescB=Math.sqrt(2*B.mass/B.radius);
  var gA=A.mass/(A.radius*A.radius),gB=B.mass/(B.radius*B.radius);
  var synodic=2*Math.PI/Math.abs(A.omega-B.omega);
  // Budget: a vertical launch with gravity losses, the Hohmann burns, a braking burn with
  // gravity losses on arrival, and a margin. A good bot lands well inside it.
  var fuel=+(1.5*vescA+dv1+dv2+2.0*vescB+0.4).toFixed(2);
  // The deadline is set from the day's first Hohmann window, so a direct transfer is always possible.
  var need=Math.PI-B.omega*tH,dw=B.omega-A.omega,phase0=B.angle0-A.angle0;
  var w0=(((need-phase0)/dw)%synodic+synodic)%synodic;
  var deadline=+(w0+1.6*tH+2).toFixed(1);
  return {
    seed:seed>>>0,G:1,name:systemName,sun:sun,bodies:bodies,start:st,target:tg,
    rocket:{maxThrust:+(3*Math.max(gA,gB)).toFixed(3),fuel:fuel,padAngle:rnd()*Math.PI*2},
    deadline:deadline,safeLandingSpeed:0.03,
    hints:{transferTime:tH,synodic:synodic,hohmannDv:dv1+dv2,escapeStart:vescA,escapeTarget:vescB}
  };
}
function bodyAt(w,k,t){
  var b=w.bodies[k],a=b.angle0+b.omega*t,c=Math.cos(a),s=Math.sin(a),v=b.orbitR*b.omega;
  return {x:b.orbitR*c,y:b.orbitR*s,vx:-v*s,vy:v*c};
}
function fly(w,ctrl,opts){
  opts=opts||{};
  var bodies=w.bodies,nb=bodies.length,S=w.start,T=w.target,maxA=w.rocket.maxThrust,sunM=w.sun.mass,sunR=w.sun.radius;
  var outer=bodies[nb-1].orbitR*1.6;
  var bx=new Float64Array(nb),by=new Float64Array(nb),bvx=new Float64Array(nb),bvy=new Float64Array(nb);
  function positions(tt){for(var k=0;k<nb;k++){var b=bodies[k],a=b.angle0+b.omega*tt,c=Math.cos(a),s=Math.sin(a),v=b.orbitR*b.omega;bx[k]=b.orbitR*c;by[k]=b.orbitR*s;bvx[k]=-v*s;bvy[k]=v*c;}}
  var gx=0,gy=0;
  function grav(tt,px,py){
    positions(tt);
    var r2=px*px+py*py,r=Math.sqrt(r2),g=-sunM/(r2*r);
    gx=g*px;gy=g*py;
    for(var k=0;k<nb;k++){var ddx=px-bx[k],ddy=py-by[k],d2=ddx*ddx+ddy*ddy,d=Math.sqrt(d2),gm=-bodies[k].mass/(d2*d);gx+=gm*ddx;gy+=gm*ddy;}
  }
  var pa=w.rocket.padAngle,padR=bodies[S].radius,gSurf=bodies[S].mass/(padR*padR);
  var t=0;positions(0);
  var x=bx[S]+padR*Math.cos(pa),y=by[S]+padR*Math.sin(pa),vx=bvx[S],vy=bvy[S];
  var fuel=w.rocket.fuel,onPad=true,outcome='timeout',closest=Infinity,landingSpeed=null,into=null;
  var samples=opts.record?[]:null,lastRec=-1;
  var state={t:0,x:0,y:0,vx:0,vy:0,fuel:0,onPad:true,bodies:[]};
  for(var k=0;k<nb;k++)state.bodies.push({x:0,y:0,vx:0,vy:0});
  var guard=0;
  while(t<w.deadline&&guard++<400000){
    positions(t);
    state.t=t;state.x=x;state.y=y;state.vx=vx;state.vy=vy;state.fuel=fuel;state.onPad=onPad;
    for(var k=0;k<nb;k++){var sb=state.bodies[k];sb.x=bx[k];sb.y=by[k];sb.vx=bvx[k];sb.vy=bvy[k];}
    var c=ctrl(state)||{};
    var thr=+c.throttle;if(!(thr>0))thr=0;else if(thr>1)thr=1;
    var dx=+c.dx,dy=+c.dy,dn=Math.sqrt(dx*dx+dy*dy);
    if(!(dn>0)){dx=0;dy=0;thr=0;}else{dx/=dn;dy/=dn;}
    if(fuel<=0)thr=0;
    var aT=thr*maxA;
    // adaptive step: a fraction of the local orbital period around the nearest strong body
    var dt=0.02,rr=Math.sqrt(x*x+y*y);
    var Ts=2*Math.PI*Math.sqrt(rr*rr*rr/sunM);if(Ts/300<dt)dt=Ts/300;
    for(var k=0;k<nb;k++){var ddx=x-bx[k],ddy=y-by[k],d=Math.sqrt(ddx*ddx+ddy*ddy);var Tl=2*Math.PI*Math.sqrt(d*d*d/bodies[k].mass);if(Tl/300<dt)dt=Tl/300;}
    if(thr>0){var dvStep=0.003/aT;if(dt>dvStep)dt=dvStep;}
    if(dt<0.0003)dt=0.0003;
    if(t+dt>w.deadline)dt=w.deadline-t;
    if(samples&&(t-lastRec>=0.004||dt<0.002)){samples.push([t,x,y,vx,vy,thr,dx,dy,fuel]);lastRec=t;}
    if(onPad){
      var ux=x-bx[S],uy=y-by[S],ur=Math.sqrt(ux*ux+uy*uy);ux/=ur;uy/=ur;
      var up=aT*(dx*ux+dy*uy);
      if(up<=gSurf){
        fuel-=aT*dt;if(fuel<0)fuel=0;t+=dt;positions(t);
        x=bx[S]+padR*Math.cos(pa);y=by[S]+padR*Math.sin(pa);vx=bvx[S];vy=bvy[S];
        continue;
      }
      onPad=false;
    }
    var ax=aT*dx,ay=aT*dy,h=dt/2;
    grav(t,x,y);var k1vx=gx+ax,k1vy=gy+ay,k1x=vx,k1y=vy;
    grav(t+h,x+k1x*h,y+k1y*h);var k2vx=gx+ax,k2vy=gy+ay,k2x=vx+k1vx*h,k2y=vy+k1vy*h;
    grav(t+h,x+k2x*h,y+k2y*h);var k3vx=gx+ax,k3vy=gy+ay,k3x=vx+k2vx*h,k3y=vy+k2vy*h;
    grav(t+dt,x+k3x*dt,y+k3y*dt);var k4vx=gx+ax,k4vy=gy+ay,k4x=vx+k3vx*dt,k4y=vy+k3vy*dt;
    x+=dt/6*(k1x+2*k2x+2*k3x+k4x);y+=dt/6*(k1y+2*k2y+2*k3y+k4y);
    vx+=dt/6*(k1vx+2*k2vx+2*k3vx+k4vx);vy+=dt/6*(k1vy+2*k2vy+2*k3vy+k4vy);
    fuel-=aT*dt;if(fuel<0)fuel=0;
    t+=dt;
    positions(t);
    rr=Math.sqrt(x*x+y*y);
    if(rr<=sunR){outcome='burned';into='the sun';break;}
    var hit=false;
    for(var k=0;k<nb;k++){
      var ddx=x-bx[k],ddy=y-by[k],d=Math.sqrt(ddx*ddx+ddy*ddy);
      if(k===T&&d-bodies[k].radius<closest)closest=d-bodies[k].radius;
      if(d<=bodies[k].radius){
        var rvx=vx-bvx[k],rvy=vy-bvy[k],rs=Math.sqrt(rvx*rvx+rvy*rvy);
        landingSpeed=rs;into=bodies[k].name;
        outcome=(k===T&&rs<=w.safeLandingSpeed)?'landed':'crashed';
        hit=true;break;
      }
    }
    if(hit)break;
    if(rr>outer){outcome='lost';break;}
  }
  if(samples)samples.push([t,x,y,vx,vy,0,0,0,fuel]);
  return {outcome:outcome,body:into,fuelUsed:+(w.rocket.fuel-fuel).toFixed(4),time:+t.toFixed(3),
    closestApproach:closest===Infinity?null:+closest.toFixed(4),landingSpeed:landingSpeed==null?null:+landingSpeed.toFixed(4),samples:samples};
}

if (typeof module !== "undefined" && module.exports) module.exports = { makeWorld: makeWorld, bodyAt: bodyAt, fly: fly, mulberry32: mulberry32 };
