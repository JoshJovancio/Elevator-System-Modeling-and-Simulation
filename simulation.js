const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 720;
const TOP_PAD = 150;
const BOTTOM_PAD = 42;
const LEFT_PAD = 78;
const FLOOR_HEIGHT = 48;
const START_MINUTE = 6 * 60 + 30;
const END_MINUTE = 18 * 60;

let simMinute = START_MINUTE;
let lastMillis = 0;
let elevators = [];
let floorQueues = [];
let waitSegments = [];
let finalWaits = [];
let totalServed = 0;
let totalTransfers = 0;
let totalSpawned = 0;
let paused = false;
let dayComplete = false;
let runtimeConfig = structuredClone(APP_CONFIG);
let peopleOnFloor = [];

function setup() {
    const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
    canvas.parent("canvas-wrap");
    textFont("Inter, Arial, sans-serif");
    setupLiveControls();
    resetSimulation();
}

function setupLiveControls() {
    const pauseBtn = document.getElementById("pauseBtn");
    const strategyInput = document.getElementById("strategyInput");
    const speedInput = document.getElementById("speedInput");
    const arrivalInput = document.getElementById("arrivalInput");
    const travelInput = document.getElementById("travelInput");
    const floor2Input = document.getElementById("floor2Input");

    strategyInput.value = runtimeConfig.strategy;
    speedInput.value = runtimeConfig.simSpeed;
    arrivalInput.value = runtimeConfig.arrivalScale;
    travelInput.value = runtimeConfig.travelTimePerFloor;
    floor2Input.checked = runtimeConfig.serveFloor2;

    pauseBtn.addEventListener("click", () => {
        paused = !paused;
        pauseBtn.textContent = paused ? "Play" : "Pause";
    });

    strategyInput.addEventListener("change", () => {
        runtimeConfig.strategy = strategyInput.value;
        reassignAllWaitingPassengers();
    });

    speedInput.addEventListener("input", () => {
        runtimeConfig.simSpeed = Number(speedInput.value);
        document.getElementById("speedValue").textContent = runtimeConfig.simSpeed.toFixed(1);
    });

    arrivalInput.addEventListener("input", () => {
        runtimeConfig.arrivalScale = Number(arrivalInput.value);
        document.getElementById("arrivalValue").textContent = runtimeConfig.arrivalScale.toFixed(2);
    });

    travelInput.addEventListener("input", () => {
        runtimeConfig.travelTimePerFloor = Number(travelInput.value);
        for (const elevator of elevators) elevator.travelSecondsPerFloor = runtimeConfig.travelTimePerFloor;
        document.getElementById("travelValue").textContent = `${runtimeConfig.travelTimePerFloor}s`;
    });

    floor2Input.addEventListener("change", () => {
        runtimeConfig.serveFloor2 = floor2Input.checked;
        reassignAllWaitingPassengers();
    });
}

function resetSimulation() {
    simMinute = START_MINUTE;
    lastMillis = millis();
    waitSegments = [];
    finalWaits = [];
    totalServed = 0;
    totalTransfers = 0;
    totalSpawned = 0;
    paused = false;
    dayComplete = false;
    document.getElementById("pauseBtn").textContent = "Pause";

    floorQueues = [];
    for (let floor = 0; floor < FLOOR_COUNT; floor++) {
        floorQueues.push(new FloorQueue(floor));
    }
    peopleOnFloor = new Array(FLOOR_COUNT).fill(0);

    elevators = [
        new Elevator(1, "BLUE", 0, runtimeConfig),
        new Elevator(2, "BLUE", 0, runtimeConfig),
        new Elevator(3, "RED", 0, runtimeConfig),
        new Elevator(4, "RED", 0, runtimeConfig),
    ];
}

function draw() {
    const now = millis();
    // Safety clamp delta to avoid hyper-jump glitches when switching browser tabs
    const elapsedSeconds = Math.min((now - lastMillis) / 1000, 0.12);
    lastMillis = now;

    if (!paused && !dayComplete) {
        const deltaSimMinutes = elapsedSeconds * runtimeConfig.simSpeed;
        simMinute += deltaSimMinutes;
        
        const timeLimitReached = simMinute >= END_MINUTE;
        
        // Count up active backpressure vectors currently in the system
        const totalQueued = floorQueues.reduce((sum, q) => sum + q.count(), 0);
        const totalOnboard = elevators.reduce((sum, e) => sum + e.cabin.length, 0);
        
        if (timeLimitReached) {
            // End session ONLY when active tasks are complete and building is physically empty
            if (totalQueued === 0 && totalOnboard === 0) {
                dayComplete = true;
            }
        } else {
            // Keep generation active during standard working hours
            generatePassengers(deltaSimMinutes);
        }
        
        // Keep elevators operating through the final deliveries
        stepElevators(elapsedSeconds * runtimeConfig.simSpeed * 60);
    }

    drawBackground();
    drawBuilding();
    drawQueues();
    drawElevators();
    drawDashboard();
    drawLegend();
}

function generatePassengers(deltaMinutes) {
    const phase = currentPhase(simMinute);
    if (phase.kind === "closed") return;

    const validFloors = allowedOperationalFloors(runtimeConfig.serveFloor2);
    const expected = phase.rate * runtimeConfig.arrivalScale * deltaMinutes;
    const arrivals = samplePoisson(expected);

    for (let i = 0; i < arrivals; i++) {
        let origin = passengerOrigin(phase, validFloors);
        let destination = passengerDestination(origin, phase, validFloors);
        while (destination === origin) destination = passengerDestination(origin, phase, validFloors);

        const passenger = new Passenger(origin, destination, simMinute, runtimeConfig.strategy);
        assignPassenger(passenger);
        
        // FIX: Spawning from an academic floor means they are leaving that room pool
        if (origin >= 3 && origin <= 10) {
            peopleOnFloor[origin]--;
        }
        
        floorQueues[origin].add(passenger);
        totalSpawned++;
    }
}

function stepElevators(deltaSeconds) {
    for (const elevator of elevators) {
        if (elevator.state === "IDLE") {
            const nextTarget = selectNextTarget(elevator, floorQueues, runtimeConfig.strategy);
            if (nextTarget !== null && nextTarget === elevator.integerFloor()) {
                handleExchange(elevator);
            } else if (nextTarget !== null) {
                elevator.setTarget(nextTarget);
            }
        }

        const result = elevator.step(deltaSeconds, floorQueues, runtimeConfig.strategy);
        if (result === "ARRIVED") {
            handleExchange(elevator);
        } else if (result === "READY") {
            dispatchElevator(elevator);
        }
    }
}

function handleExchange(elevator) {
    const floorIdx = elevator.integerFloor();
    const stillRiding = [];

    for (const passenger of elevator.cabin) {
        if (passenger.immediateDestination !== floorIdx) {
            stillRiding.push(passenger);
            continue;
        }

        if (passenger.immediateDestination === passenger.finalDestination) {
            totalServed++;
            finalWaits.push(simMinute - passenger.createdAt);
            
            // FIX: Only increment when they have physically arrived at a final classroom destination
            if (passenger.finalDestination >= 3 && passenger.finalDestination <= 10) {
                peopleOnFloor[passenger.finalDestination]++;
            }
            // Lobby drops (Floor 0) require no action here, as they were already 
            // decremented from their origin floor when they spawned.
        } else {
            // Transferring Passenger (Interchange bridge loop via Floor 5)
            // No room count alterations are made here since they remain in transit
            const transferPassenger = new Passenger(
                floorIdx,
                passenger.finalDestination,
                passenger.createdAt,
                runtimeConfig.strategy,
                passenger.transferCount + 1,
                passenger.originalOrigin
            );
            transferPassenger.queueEnteredAt = simMinute;
            assignPassenger(transferPassenger);
            floorQueues[floorIdx].add(transferPassenger);
            totalTransfers++;
        }
    }

    elevator.cabin = stillRiding;
    if (elevator.cabin.length === 0) {
        elevator.capacity = randomCapacity(elevator.capacityMin, elevator.capacityMax);
    }

    const capacityLeft = elevator.capacity - elevator.cabin.length;
    const boarded = floorQueues[floorIdx].takeForElevator(elevator, capacityLeft, runtimeConfig.strategy);

    for (const passenger of boarded) {
        waitSegments.push(simMinute - passenger.queueEnteredAt);
        passenger.boardedAt = simMinute;
    }

    elevator.cabin.push(...boarded);
    elevator.doorRemaining = elevator.doorSeconds + boarded.length * elevator.boardingSeconds + stillRiding.length * 0.15;
    elevator.state = "LOADING";
}

function assignPassenger(passenger) {
    passenger.immediateDestination = routeImmediateDestination(
        passenger.origin,
        passenger.finalDestination,
        runtimeConfig.strategy
    );
    const elevator = chooseBestElevator(
        passenger.origin,
        passenger.immediateDestination,
        elevators,
        floorQueues,
        runtimeConfig.strategy
    );
    passenger.assignedElevatorId = elevator.id;
}

function reassignAllWaitingPassengers() {
    for (const queue of floorQueues) {
        for (const passenger of queue.waiting) {
            passenger.origin = queue.floorIdx;
            assignPassenger(passenger);
        }
    }

    for (const elevator of elevators) {
        elevator.travelSecondsPerFloor = runtimeConfig.travelTimePerFloor;
        if (elevator.state === "IDLE") elevator.direction = 0;
    }
}

function dispatchElevator(elevator) {
    const floorIdx = elevator.integerFloor();
    const nextTarget = selectNextTarget(elevator, floorQueues, runtimeConfig.strategy);
    if (nextTarget !== null && nextTarget === floorIdx) {
        handleExchange(elevator);
    } else if (nextTarget !== null) {
        elevator.setTarget(nextTarget);
    } else if (elevator.cabin.length > 0) {
        elevator.setTarget(nearestFloor(floorIdx, elevator.cabin.map((p) => p.immediateDestination)));
    } else {
        elevator.state = "IDLE";
        elevator.direction = 0;
    }
}

function currentPhase(minute) {
    const rates = runtimeConfig.rates;
    const windows = [
        { start: 7 * 60 + 5, end: 7 * 60 + 35, kind: "course_start", rate: rates.morning },
        { start: 9 * 60 + 10, end: 9 * 60 + 35, kind: "transition", rate: rates.transition },
        { start: 11 * 60 + 50, end: 13 * 60 + 5, kind: "lunch", rate: rates.lunch },
        { start: 14 * 60 + 55, end: 15 * 60 + 35, kind: "transition", rate: rates.transition },
        { start: 16 * 60 + 55, end: 17 * 60 + 35, kind: "outflow", rate: rates.outflow },
    ];

    for (const window of windows) {
        if (minute >= window.start && minute <= window.end) return window;
    }

    if (minute >= 7 * 60 + 30 && minute <= 17 * 60) {
        return { kind: "class_time", rate: rates.classTime };
    }

    return { kind: "closed", rate: 0 };
}

function samplePoisson(lambda) {
    if (lambda <= 0) return 0;
    const limit = Math.exp(-lambda);
    let product = 1;
    let count = 0;

    do {
        count++;
        product *= random(1);
    } while (product > limit);

    return count - 1;
}

function drawBackground() {
    background("#f8fafc");
    noStroke();
    fill("#ffffff");
    rect(18, 18, CANVAS_WIDTH - 36, CANVAS_HEIGHT - 36, 8);
}

function drawBuilding() {
    const shaftTop = TOP_PAD;
    const shaftBottom = TOP_PAD + FLOOR_HEIGHT * FLOOR_COUNT;

    stroke("#dbe3ef");
    strokeWeight(1);
    for (let floor = 0; floor < FLOOR_COUNT; floor++) {
        const y = floorY(floor);
        line(LEFT_PAD, y, CANVAS_WIDTH - 42, y);

        noStroke();
        fill(floor === 1 && !runtimeConfig.serveFloor2 ? "#9aa7ba" : "#354158");
        textAlign(RIGHT, CENTER);
        textStyle(BOLD);
        textSize(12);
        text(`F${floor + 1}`, LEFT_PAD - 16, y - FLOOR_HEIGHT / 2);
    }

    for (let i = 0; i < LIFT_COUNT; i++) {
        const x = elevatorX(i + 1);
        stroke("#c8d3e3");
        strokeWeight(2);
        line(x + 36, shaftTop, x + 36, shaftBottom);
        noStroke();
        fill("#eef3f8");
        rect(x, shaftTop, 72, shaftBottom - shaftTop, 5);
    }
}

function drawQueues() {
    for (let floor = FLOOR_COUNT - 1; floor >= 0; floor--) {
        const y = floorY(floor) - FLOOR_HEIGHT + 8;
        const queue = floorQueues[floor];
        const waiting = queue.count();
        if (waiting === 0) continue;

        const up = queue.count(1);
        const down = queue.count(-1);
        const summary = queue.destinationSummary().join("  ");

        fill("#172033");
        textAlign(LEFT, TOP);
        textStyle(BOLD);
        textSize(10);
        text(`Q ${waiting}`, 96, y);

        fill("#3c7dd9");
        rect(132, y - 1, 34, 15, 3);
        fill("#ffffff");
        textAlign(CENTER, CENTER);
        textSize(9);
        text(`U ${up}`, 149, y + 6);

        fill("#d94b4b");
        rect(170, y - 1, 34, 15, 3);
        fill("#ffffff");
        text(`D ${down}`, 187, y + 6);

        fill("#59677f");
        textAlign(LEFT, TOP);
        textSize(9);
        textStyle(NORMAL);
        text(summary, 214, y + 1);

        for (let liftId = 1; liftId <= LIFT_COUNT; liftId++) {
            const assigned = queue.countForElevator(liftId);
            if (assigned === 0) continue;
            const badgeX = 214 + (liftId - 1) * 42;
            fill(liftId <= 2 ? "#dbeafe" : "#fee2e2");
            stroke(liftId <= 2 ? "#3c7dd9" : "#d94b4b");
            rect(badgeX, y + 16, 36, 14, 3);
            noStroke();
            fill("#172033");
            textAlign(CENTER, CENTER);
            textSize(8);
            text(`E${liftId}:${assigned}`, badgeX + 18, y + 23);
        }
    }
}

function drawElevators() {
    for (const elevator of elevators) {
        const x = elevatorX(elevator.id);
        const y = floorToY(elevator.currentFloor);
        const color = elevator.zone === "BLUE" ? "#2f6edb" : "#d94949";

        fill(color);
        stroke("#172033");
        strokeWeight(1.5);
        rect(x + 7, y + 5, 58, FLOOR_HEIGHT - 10, 5);

        fill("#ffffff");
        noStroke();
        textAlign(CENTER, CENTER);
        textStyle(BOLD);
        textSize(11);
        text(`E${elevator.id}`, x + 36, y + 16);

        textStyle(NORMAL);
        textSize(9);
        const state = elevator.state === "LOADING" ? "OPEN" : elevator.direction > 0 ? "UP" : elevator.direction < 0 ? "DOWN" : "IDLE";
        text(`${state} ${elevator.cabin.length}/${elevator.capacity}`, x + 36, y + 31);

        if (elevator.cabin.length > 0) {
            const dests = [...new Set(elevator.cabin.map((p) => p.immediateDestination + 1))]
                .sort((a, b) => a - b)
                .slice(0, 4)
                .join(",");
            textSize(8);
            text(`to ${dests}`, x + 36, y + 42);
        }
    }
}

function drawDashboard() {
    const phase = currentPhase(simMinute);
    const queueTotal = floorQueues.reduce((sum, queue) => sum + queue.count(), 0);
    const onboardTotal = elevators.reduce((sum, elevator) => sum + elevator.cabin.length, 0);
    const avgWait = average(waitSegments);
    const maxWait = waitSegments.length ? Math.max(...waitSegments) : 0;
    const avgFinalWait = average(finalWaits);
    const utilization = average(elevators.map((e) => e.busySeconds / max(1, (simMinute - START_MINUTE) * 60))) * 100;

    fill("#172033");
    noStroke();
    textAlign(LEFT, TOP);
    textStyle(BOLD);
    textSize(18);
    text("Real-Time Elevator Dispatch Simulation", 34, 28);

    textSize(12);
    textStyle(NORMAL);
    fill("#59677f");
    text(`${runtimeConfig.strategy} strategy | ${formatMinute(simMinute)} | ${phaseLabel(phase.kind)}`, 34, 52);

    const cards = [
        ["Served", totalServed],
        ["Spawned", totalSpawned],
        ["Waiting", queueTotal],
        ["Onboard", onboardTotal],
        ["Avg wait", `${avgWait.toFixed(1)} min`],
        ["Max wait", `${maxWait.toFixed(1)} min`],
        ["Final wait", `${avgFinalWait.toFixed(1)} min`],
        ["Transfers", totalTransfers],
        ["Util.", `${utilization.toFixed(0)}%`],
    ];

    const startX = 448;
    for (let i = 0; i < cards.length; i++) {
        const x = startX + (i % 3) * 136;
        const y = 28 + Math.floor(i / 3) * 39;
        fill("#f1f5f9");
        stroke("#dbe3ef");
        rect(x, y, 124, 30, 6);
        noStroke();
        fill("#59677f");
        textAlign(LEFT, TOP);
        textSize(9);
        text(cards[i][0], x + 9, y + 5);
        fill("#172033");
        textStyle(BOLD);
        textSize(12);
        text(cards[i][1], x + 64, y + 8);
        textStyle(NORMAL);
    }

    if (paused || dayComplete) {
        fill(255, 255, 255, 228);
        rect(250, 294, 500, 82, 8);
        fill("#172033");
        textAlign(CENTER, CENTER);
        textStyle(BOLD);
        textSize(18);
        text(dayComplete ? "Simulation day complete" : "Simulation paused", CANVAS_WIDTH / 2, 324);
        textStyle(NORMAL);
        textSize(12);
        text(dayComplete ? "Press R to replay the day with the current live settings." : "Press Play or Space to continue.", CANVAS_WIDTH / 2, 350);
    }

    // drawFloorPopulationPanel();
}

// function drawFloorPopulationPanel() {
//     // Places the panel completely on the left side of the canvas bottom area
//     const x = 34;
//     const y = 682; // Positioned perfectly in the remaining margin
    
//     noStroke();
//     fill("#172033");
//     textAlign(LEFT, CENTER);
//     textStyle(BOLD);
//     textSize(10);
//     text("Heavy Floors:", x, y + 8);

//     const floors = [3, 4, 5, 6, 7, 8, 9, 10];
//     for (let i = 0; i < floors.length; i++) {
//         const floor = floors[i];
//         // Tight, clean micro-badges spaced out to avoid colliding with the right-hand legend
//         const itemX = x + 76 + (i * 48); 
        
//         fill("#eef3f8");
//         stroke("#c8d3e3");
//         strokeWeight(1);
//         rect(itemX, y, 42, 16, 3);
        
//         noStroke();
//         fill("#59677f");
//         textAlign(LEFT, CENTER);
//         textStyle(NORMAL);
//         textSize(9);
//         text(`F${floor + 1}`, itemX + 4, y + 8);
        
//         fill("#172033");
//         textAlign(RIGHT, CENTER);
//         textStyle(BOLD);
//         textSize(9);
//         text(peopleOnFloor[floor], itemX + 38, y + 8);
//     }
// }

function drawLegend() {
    // Aligned on the exact same baseline (y = 682), but shifted completely to the right side of the canvas
    const y = 682; 
    
    // Blue Strategy Swatch
    fill("#2f6edb");
    noStroke();
    rect(520, y + 2, 12, 12, 3);
    
    // Red Strategy Swatch
    fill("#d94949");
    rect(640, y + 2, 12, 12, 3);

    // Typographic adjustments
    fill("#59677f");
    textStyle(NORMAL);
    textSize(10);
    
    textAlign(LEFT, CENTER);
    text("Blue: F1, F3-F7", 538, y + 8);
    text("Red: F1, F5, F8-F11", 658, y + 8);

    // Context instructions anchored safely to the bottom-right corner bounding margin
    textAlign(RIGHT, CENTER);
    text("Space: Pause | R: Reset", CANVAS_WIDTH - 34, y + 8);
}

function keyPressed() {
    if (key === " ") {
        paused = !paused;
        document.getElementById("pauseBtn").textContent = paused ? "Play" : "Pause";
    }
    if (key === "r" || key === "R") resetSimulation();
}

function floorY(floorIdx) {
    return TOP_PAD + FLOOR_HEIGHT * (FLOOR_COUNT - floorIdx);
}

function floorToY(currentFloor) {
    return TOP_PAD + FLOOR_HEIGHT * (FLOOR_COUNT - 1 - currentFloor);
}

function elevatorX(id) {
    return 502 + (id - 1) * 94;
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMinute(minute) {
    const bounded = Math.min(minute, END_MINUTE);
    const hours = Math.floor(bounded / 60);
    const minutes = Math.floor(bounded % 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function phaseLabel(kind) {
    const labels = {
        course_start: "course-start inflow",
        transition: "between-class transition",
        lunch: "lunch and cafeteria movement",
        outflow: "end-of-day outflow",
        class_time: "low background demand",
        closed: "building quiet",
    };
    return labels[kind] || kind;
}
