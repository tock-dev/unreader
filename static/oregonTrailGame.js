class OregonTrailGame {
  constructor(options = {}) {
    this.onMessage = options.onMessage || ((msg) => console.log(msg));
    this.onInput = options.onInput || (() => Promise.resolve(''));
    this.onGameEnd = options.onGameEnd || (() => {});
    this.onStateChange = options.onStateChange || (() => {});

    this.gameVariables = this.setup();
  }

  setup() {
    return {
      animals: 0,
      ammunition: 0,
      clothing: 0,
      insufficient_clothing: false,
      event_counter: 0,
      game_turn: 0,
      shooting_expert_level: 0,
      eating_choice: 0,
      food: 0,
      south_pass_flag: false,
      injury: false,
      blizzard: false,
      mileage: 0,
      supplies: 0,
      turn_mileage: 0,
      South_Pass_Mileage_Flag: false,
      illness: false,
      cash: 700,
      fort_flag: false
    };
  }

  log(message) {
    this.onMessage(message);
  }

  async prompt(message, type = 'number') {
    const response = await this.onInput(message, type);
    if (type === 'number') {
      const parsed = parseInt(response, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return response;
  }

  updateState() {
    this.onStateChange({ ...this.gameVariables });
  }

  // Randomly shoot - returns a score based on how quickly the user responds
  async shooting() {
    this.log("\nYou pull your gun, aim, and pull the trigger");
    
    const startTime = Date.now();
    const maxTime = 15000; // 15 seconds in milliseconds
    
    // Wait for user input (spacebar or similar trigger from UI)
    const userResponse = await this.onInput("SHOOT", 'shoot');
    const elapsedTime = Date.now() - startTime;

    if (elapsedTime > maxTime) {
      this.log("Pop");
      return 5;
    } else if (elapsedTime < 1000) {
      this.log("Wham!");
      return 1;
    } else if (elapsedTime < 2000) {
      this.log("POW!");
      return 2;
    } else if (elapsedTime < 4000) {
      this.log("Blam!");
      return 3;
    } else {
      this.log("Bang");
      return 4;
    }
  }

  illness() {
    if (Math.random() * 100 < 10 + 35 * (this.gameVariables.eating_choice - 1)) {
      this.log("Wild Illness - Medicine Used.");
      this.gameVariables.mileage -= 5;
      this.gameVariables.supplies -= 2;
    } else if (Math.random() * 100 < 100 - (40 / Math.pow(4, this.gameVariables.eating_choice - 1))) {
      this.log("Bad Illness - Medicine Used.");
      this.gameVariables.mileage -= 5;
      this.gameVariables.supplies -= 5;
    } else {
      this.log("Serious Illness - You must stop for Medical Attention.");
      this.gameVariables.illness = false;
      this.gameVariables.supplies -= 10;
    }

    if (this.gameVariables.supplies < 10) {
      this.dying("no_supplies");
    }

    if (this.gameVariables.blizzard === true) {
      return;
    }
  }

  mountains() {
    const mountainCheck = 9 - (Math.pow(this.gameVariables.mileage / 100 - 15, 2) + 72) /
      (Math.pow(this.gameVariables.mileage / 100 - 15, 2) + 12);

    if (Math.random() * 10 > mountainCheck) {
      if (this.gameVariables.south_pass_flag) {
        this.gameVariables.south_pass_flag = true;

        if (Math.random() * 100 < 81) {
          this.log("You have been caught in a Blizzard in the Mountain Pass - Time and Supplies lost.");
          this.blizzard();
        } else {
          this.log("You made it safely through the South Pass -- No Snow");
          if (this.gameVariables.mileage < 1700) {
            this.gameVariables.South_Pass_Mileage_Flag = true;
          }
        }
      } else {
        this.log("\nYou find yourself in some rugged mountains.");
        this.gameVariables.mileage -= 60;

        if (Math.random() * 100 < 34) {
          this.log("You have been caught in a Blizzard in the Mountain Pass - Time and Supplies lost.");
          this.blizzard();
        } else if (Math.random() * 100 > 10) {
          this.log("\nWagon Damaged! - Lose time and supplies.\nThe going gets slow.");
          this.gameVariables.supplies -= 5;
          this.gameVariables.ammunition -= 200;
          this.gameVariables.clothing -= Math.floor(Math.random() * 40) + 1;
          this.gameVariables.mileage -= 30 + Math.floor(Math.random() * 40) + 1;
        } else if (Math.random() * 100 > 10) {
          this.log("\nYou got lost - lose valuable time trying to find the trail!");
          this.gameVariables.mileage -= 60;
        }
      }
    }
  }

  blizzard() {
    let baseChanceOfBlizzardOver = 20;
    const blizzardLoop = setInterval(() => {
      this.log("\nThe Snow and wind continues to rage.");
      this.gameVariables.blizzard = true;
      this.gameVariables.food -= 25;
      this.gameVariables.supplies -= 10;
      this.gameVariables.ammunition -= 300;
      this.gameVariables.mileage -= 30 + Math.floor(Math.random() * 40) + 1;

      if (this.gameVariables.clothing < 18 + Math.floor(Math.random() * 3) + 1) {
        this.illness();
      }

      if (Math.random() * 100 < baseChanceOfBlizzardOver) {
        this.log("\nHurray! The Snow and wind start to break.");
        clearInterval(blizzardLoop);
        return;
      }

      baseChanceOfBlizzardOver += 10;

      if (this.gameVariables.mileage < 1000) {
        this.log("\nThrough the wind and snow, you finally make it out of the mountains. But the wrong side.");
        clearInterval(blizzardLoop);
        return;
      }

      if (this.gameVariables.food < 0) {
        this.gameVariables.food = 0;
        this.dying("no_food");
        clearInterval(blizzardLoop);
        return;
      }

      if (this.gameVariables.supplies < 0) {
        this.gameVariables.supplies = 0;
        this.dying("no_supplies");
        clearInterval(blizzardLoop);
        return;
      }
    }, 5000);
  }

  dying(reason) {
    let message = "";

    if (reason) {
      if (reason === "no_food") {
        message = "You ran out of food and starved to death.\n";
      } else if (reason === "no_doctor") {
        message = "You can't afford a doctor.\n";
      } else if (reason === "no_supplies") {
        message = "You ran out of medical supplies\n";
      } else if (reason === "injury") {
        message = "You died of injuries.\n";
      }
    }

    message += "Due to your unfortunate situation, there are a few formalities we must go through\n\n";
    message += "Would you like a minister?\n";
    message += "Would you like a fancy funeral?\n";
    message += "Would you like us to inform your next of kin?\n\n";
    message += "But your Aunt Sadie in St. Louis is really worried about you.\n";
    message += "That will be $4.50 for the telegraph charge.\n\n";
    message += "We thank you for this information and we are sorry you didn't make it to the great territory of Oregon.\n";
    message += "Better luck next time.\n\n";
    message += "\tSincerely,\n";
    message += "\tThe Oregon City Chamber of Commerce";

    this.log(message);
    this.onGameEnd({ reason, gameVariables: this.gameVariables });
  }

  async buyingRoutine(objectName, minAmount, maxAmount, wallet) {
    while (true) {
      const input = await this.prompt(`Wallet: ${wallet}. How much do you want to spend on your ${objectName}: `, 'number');
      
      if (input === null) {
        this.log("Sorry, I didn't understand that.");
        continue;
      }

      if (input < minAmount) {
        this.log("Sorry, that is not enough.");
        continue;
      } else if (input > maxAmount) {
        this.log("Sorry, that is too much.");
        continue;
      } else if (input > wallet) {
        this.log("You don't have that much - keep your spending down.");
      } else {
        return input;
      }
    }
  }

  async initialPurchases() {
    this.log("You have $700 to spend on supplies for your journey.\n");

    const oxen = await this.buyingRoutine("oxen team", 200, 300, this.gameVariables.cash);
    this.gameVariables.cash -= oxen;

    const food = await this.buyingRoutine("food", 1, 99999, this.gameVariables.cash);
    this.gameVariables.cash -= food;

    const ammo = await this.buyingRoutine("ammunition", 1, 99999, this.gameVariables.cash);
    this.gameVariables.cash -= ammo;

    const clothing = await this.buyingRoutine("clothing", 1, 99999, this.gameVariables.cash);
    this.gameVariables.cash -= clothing;

    const misc = await this.buyingRoutine("miscellaneous supplies", 1, 99999, this.gameVariables.cash);
    this.gameVariables.cash -= misc;

    const total = 700 - oxen - clothing - ammo - food - misc;
    if (total < 0) {
      this.log("You Overspent -- You only had $700 to spend. Try Again.");
      return this.initialPurchases();
    }

    this.log(`After all your purchases. You now have ${total} dollars left.`);

    this.gameVariables.cash = total;
    this.gameVariables.animals = oxen;
    this.gameVariables.ammunition = ammo * 50;
    this.gameVariables.clothing = clothing;
    this.gameVariables.food = food;
    this.gameVariables.supplies = misc;

    this.updateState();
  }

  showInstructions() {
    const instructions = `
This program simulates a trip over the oregon trail from Independence,
Missouri to Oregon City, Oregon in 1847 your family of five will cover
the 2040 mile Oregon Trail in 5-6 months --- if you make it alive.

You had saved $900 to spend for the trip, and you've just paid $200 for a wagon.
You will need to spend the rest of your money on the following items:

     Oxen - you can spend $200-$300 on your team
            the more you spend, the faster you'll go
            because you'll have better animals

     Food - the more you have, the less chance there
            is of getting sick

     Ammunition - $1 buys a belt of 50 bullets
            you will need bullets for attacks by animals
            and bandits, and for hunting food

     Clothing - this is especially important for the cold
            weather you will encounter when crossing
            the mountains

     Miscellaneous supplies - this includes medicine and
            other things you will need for sickness and
            emergency repairs

You can spend all your money before you start your trip -
or you can save some of your cash to spend at forts along
the way when you run low. However, items cost more at
the forts. You can also go hunting along the way to get
more food.

Whenever you have to use your trusty rifle along the way,
you will be told to type in a word (one that sounds like a 
gun shot). the faster you type in that word and hit the
'return' key, the better luck you'll have with your gun.

at each turn, all items are shown in dollar amounts
except bullets. When asked to enter money amounts, don't use a "$".

Good luck!!!`;
    this.log(instructions);
  }

  userStats() {
    if (this.gameVariables.food < 0) this.gameVariables.food = 0;
    if (this.gameVariables.ammunition < 0) this.gameVariables.ammunition = 0;
    if (this.gameVariables.clothing < 0) this.gameVariables.clothing = 0;
    if (this.gameVariables.supplies < 0) this.gameVariables.supplies = 0;
    if (this.gameVariables.cash < 0) this.gameVariables.cash = 0;

    const stats = `
Food:            ${this.gameVariables.food}
Bullets:         ${this.gameVariables.ammunition}
Clothing:        ${this.gameVariables.clothing}
Misc. Supplies:  ${this.gameVariables.supplies}
Cash:            ${this.gameVariables.cash}`;
    this.log(stats);
    this.updateState();
  }

  finalTurn() {
    this.log("\nYou finally arrived at Oregon City\nafter 2040 long miles - Hooray!!\nA Real Pioneer!");

    const timeCalculation = (2040 - this.gameVariables.turn_mileage) /
      (this.gameVariables.mileage - this.gameVariables.turn_mileage);
    this.gameVariables.food += (1 - timeCalculation) * (8 + 5 * this.gameVariables.eating_choice);

    let timeCalcInt = Math.floor(timeCalculation * 14);
    this.gameVariables.game_turn = this.gameVariables.game_turn * 14 + timeCalcInt;

    if (timeCalcInt < 0) timeCalcInt = 0;
    if (timeCalcInt > 7) timeCalcInt = 6;

    const daysList = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const theDay = daysList[timeCalcInt];

    let dateString = "";
    if (this.gameVariables.game_turn < 124) {
      this.gameVariables.game_turn -= 93;
      dateString = `${theDay}, July ${this.gameVariables.game_turn}, 1847`;
    } else if (this.gameVariables.game_turn < 155) {
      this.gameVariables.game_turn -= 124;
      dateString = `${theDay}, August ${this.gameVariables.game_turn}, 1847`;
    } else if (this.gameVariables.game_turn < 185) {
      this.gameVariables.game_turn -= 155;
      dateString = `${theDay}, September ${this.gameVariables.game_turn}, 1847`;
    } else if (this.gameVariables.game_turn < 216) {
      this.gameVariables.game_turn -= 185;
      dateString = `${theDay}, October ${this.gameVariables.game_turn}, 1847`;
    } else if (this.gameVariables.game_turn < 246) {
      this.gameVariables.game_turn -= 216;
      dateString = `${theDay}, November ${this.gameVariables.game_turn}, 1847`;
    } else {
      this.gameVariables.game_turn -= 246;
      dateString = `${theDay}, December ${this.gameVariables.game_turn}, 1847`;
    }

    this.log(dateString);
    this.userStats();

    const finalMessage = `\tPresident James K. Polk sends you his
\theartiest congratulations and wishes you a prosperous life ahead
\tat your new home.`;
    this.log(finalMessage);

    this.onGameEnd({ reason: 'success', gameVariables: this.gameVariables });
  }

  async gameLoop() {
    if (this.gameVariables.food < 0) this.gameVariables.food = 0;
    if (this.gameVariables.ammunition < 0) this.gameVariables.ammunition = 0;
    if (this.gameVariables.clothing < 0) this.gameVariables.clothing = 0;
    if (this.gameVariables.supplies < 0) this.gameVariables.supplies = 0;

    if (this.gameVariables.food < 13) {
      this.log("\n\nYou'd better do some hunting or buy food and soon!!!!");
    }

    this.gameVariables.food = Math.floor(this.gameVariables.food);
    this.gameVariables.ammunition = Math.floor(this.gameVariables.ammunition);
    this.gameVariables.clothing = Math.floor(this.gameVariables.clothing);
    this.gameVariables.supplies = Math.floor(this.gameVariables.supplies);
    this.gameVariables.cash = Math.floor(this.gameVariables.cash);
    this.gameVariables.mileage = Math.floor(this.gameVariables.mileage);

    this.gameVariables.turn_mileage = this.gameVariables.mileage;

    if (this.gameVariables.illness || this.gameVariables.injury) {
      this.gameVariables.cash -= 20;
      this.gameVariables.illness = false;
      this.gameVariables.injury = false;
      if (this.gameVariables.cash < 0) {
        this.dying("no_doctor");
        return false;
      }
      this.log("Doctor's Bill is $20.");
    }

    if (this.gameVariables.South_Pass_Mileage_Flag) {
      this.log("Total Mileage:   950");
    } else {
      this.log(`Total Mileage:   ${this.gameVariables.mileage}`);
    }

    this.userStats();

    let choice = 0;
    if (!this.gameVariables.fort_flag) {
      while (true) {
        choice = await this.prompt("\nDo you want to (1) Hunt, or (2) Continue: ", 'number');
        if (choice === null || choice < 1 || choice > 2) {
          choice = 2;
          break;
        } else if (choice === 2 && this.gameVariables.ammunition < 39) {
          this.log("TOUGH -- You need more bullets to go hunting.");
        } else {
          this.gameVariables.fort_flag = true;
          choice += 1;
          break;
        }
      }
    } else {
      while (true) {
        choice = await this.prompt("\nDo you want to (1) Stop at the next fort, (2) Hunt, or (3) Continue: ", 'number');
        if (choice === null || choice < 1 || choice > 3) {
          choice = 3;
          break;
        } else if (choice === 2 && this.gameVariables.ammunition < 39) {
          this.log("TOUGH -- You need more bullets to go hunting.");
        } else {
          break;
        }
      }
    }

    if (choice === 1) {
      await this.fort();
    } else if (choice === 2) {
      await this.hunting();
    }

    if (this.gameVariables.food < 14) {
      this.dying("no_food");
      return false;
    }

    while (true) {
      const eatChoice = await this.prompt("Do you want to eat (1) Poorly, (2) Moderately, or (3) Well: ", 'number');
      if (eatChoice === null || eatChoice < 1 || eatChoice > 3) {
        continue;
      }
      this.gameVariables.eating_choice = eatChoice;
      const foodNeeded = 8 + 5 * eatChoice;
      if (this.gameVariables.food - foodNeeded < 0) {
        this.log("You can't eat that well.");
      } else {
        break;
      }
    }

    this.gameVariables.food -= (8 + 5 * this.gameVariables.eating_choice);
    this.gameVariables.mileage += 200 + (this.gameVariables.animals - 220) / 5 + Math.random() * 10;
    this.gameVariables.insufficient_clothing = false;
    this.gameVariables.blizzard = false;

    return true;
  }

  async fort() {
    this.log("Enter what you wish to spend on the following:");

    const food = await this.buyingRoutine("food", 0, 9999, this.gameVariables.cash);
    this.gameVariables.cash -= food;
    this.gameVariables.food += Math.floor(0.66 * food);

    const ammo = await this.buyingRoutine("ammo", 0, 9999, this.gameVariables.cash);
    this.gameVariables.cash -= ammo;
    this.gameVariables.ammunition += Math.floor(0.66 * ammo * 50);

    const clothing = await this.buyingRoutine("clothing", 0, 9999, this.gameVariables.cash);
    this.gameVariables.cash -= clothing;
    this.gameVariables.clothing += Math.floor(0.66 * clothing);

    const misc = await this.buyingRoutine("miscellaneous supplies", 0, 9999, this.gameVariables.cash);
    this.gameVariables.cash -= misc;
    this.gameVariables.supplies += Math.floor(0.66 * misc);

    this.gameVariables.mileage -= 45;
    this.updateState();
  }

  async hunting() {
    if (this.gameVariables.ammunition > 39) {
      const myShoot = await this.shooting();
      this.gameVariables.ammunition -= (Math.floor(Math.random() * 10) + 1) * 3;

      if (myShoot > 4) {
        this.log("You Missed -- and your dinner got away..");
      } else if (myShoot < 3) {
        this.log("Right Between the Eyes - You got a big one!! Full bellies tonight!");
        this.gameVariables.food += 52 + (myShoot * 6);
      } else {
        this.log("Nice Shot! Right on target - Good Eatin' Tonight");
        this.gameVariables.food += 48 - (myShoot * 2);
      }
    } else {
      this.log("You need more bullets to go hunting.");
    }

    this.gameVariables.mileage -= 45;
    if (this.gameVariables.food < 14) {
      this.dying("no_food");
    }
    this.updateState();
  }

  doEvents() {
    if (Math.random() * 100 < 50) {
      this.gameVariables.event_counter += 1;
      const newEvent = this.gameVariables.event_counter;

      if (newEvent === 1) {
        this.log("Wagon breaks down - lose time and supplies fixing it");
        this.gameVariables.supplies -= 8;
        this.gameVariables.mileage -= Math.floor(Math.random() * 5) + 1;
      } else if (newEvent === 2) {
        this.log("Ox injures leg - slows you down for the rest of trip");
        this.gameVariables.animals -= 20;
        this.gameVariables.mileage -= 25;
      } else if (newEvent === 3) {
        this.log("Bad Luck - Your daughter broke her arm\nYou had to stop and use supplies to make a sling.");
        this.gameVariables.supplies -= 5;
        this.gameVariables.mileage -= 5;
      } else if (newEvent === 4) {
        this.log("Ox wanders off - spend time looking for it.");
        this.gameVariables.mileage -= 17;
      } else if (newEvent === 5) {
        this.log("Your son gets lost - spend half the day looking for him");
        this.gameVariables.mileage -= 10;
      } else if (newEvent === 6) {
        this.log("Unsafe water - lose time looking for a clean spring.");
        this.gameVariables.mileage -= Math.floor(Math.random() * 10) + 2;
      } else if (newEvent === 7) {
        this.log("Heavy rains - time and supplies lost");
        this.gameVariables.food -= 10;
        this.gameVariables.ammunition -= 500;
        this.gameVariables.supplies -= 15;
        this.gameVariables.mileage -= Math.floor(Math.random() * 10) + 5;
      } else if (newEvent === 8) {
        this.log("Bandits Attack!");
        // Would call shooting() here but skip for now
        this.gameVariables.ammunition -= (Math.floor(Math.random() * 5) * 20);
        if (this.gameVariables.ammunition < 1) {
          this.log("You ran out of bullets - They get lots of cash");
          this.gameVariables.cash = Math.floor(this.gameVariables.cash / 3);
          this.log("You got shot in the leg and they took one of your oxen.");
          this.gameVariables.injury = true;
          this.log("Better have a doc look at your wound.");
          this.gameVariables.supplies -= 5;
          this.gameVariables.animals -= 20;
        } else {
          this.log("Quickest draw outside of Dodge City!!\nYou got 'em!");
        }
      } else if (newEvent === 9) {
        this.log("There was a fire in your wagon - Food and supplies damaged!");
        this.gameVariables.food -= 40;
        this.gameVariables.ammunition -= 400;
        this.gameVariables.mileage -= 15;
        this.gameVariables.supplies -= Math.floor(Math.random() * 8) + 3;
      } else if (newEvent === 10) {
        this.log("Lose your way in heavy fog - Time is lost");
        this.gameVariables.mileage -= 10 + Math.floor(Math.random() * 5);
      } else if (newEvent === 11) {
        this.log("You killed a poisonous snake after it bit you");
        this.gameVariables.ammunition -= 10;
        this.gameVariables.supplies -= 5;
        if (this.gameVariables.supplies < 1) {
          this.log("You die of snakebite since you have no medicine");
          this.dying("no_supplies");
        }
      } else if (newEvent === 12) {
        this.log("Wagon gets swamped fording river - lose food and clothes.");
        this.gameVariables.food -= 30;
        this.gameVariables.clothing -= 20;
        this.gameVariables.mileage -= 20 + Math.floor(Math.random() * 20);
      } else if (newEvent === 13) {
        this.log("Wild animals attack!");
        if (this.gameVariables.ammunition < 40) {
          this.log("You were too low on bullets - The wolves overpowered you");
          this.gameVariables.injury = true;
        } else {
          const myShoot = Math.floor(Math.random() * 5);
          if (myShoot > 2) {
            this.log("Slow on the draw - They got at your food and clothes.");
          } else {
            this.log("Nice Shootin' Partner - They didn't get much.");
          }
          this.gameVariables.food -= (myShoot * 8);
          this.gameVariables.clothing -= (myShoot * 4);
          this.gameVariables.ammunition -= (myShoot * 20);
        }
      } else if (newEvent === 14) {
        this.log("Cold Weather!!");
        if (this.gameVariables.clothing > Math.floor(Math.random() * 4) + 22) {
          this.log("You have enough clothing to keep you warm.");
        } else {
          this.log("You don't have enough clothing to keep you warm.");
          this.illness();
        }
      } else if (newEvent === 15) {
        this.log("Hail Storm - Supplies Damaged");
        this.gameVariables.ammunition -= 200;
        this.gameVariables.supplies -= 4 + Math.floor(Math.random() * 3);
        this.gameVariables.mileage -= 5 + Math.floor(Math.random() * 10);
      } else {
        this.log("Helpful indians show you where to find more food.");
        this.gameVariables.food += 14;
      }
    }
  }

  async riders() {
    const ridersChance = ((this.gameVariables.mileage / 100 - 4) ** 2 + 72) /
      ((this.gameVariables.mileage / 100 - 4) ** 2 + 12) - 1;

    if (Math.random() * 10 <= ridersChance) {
      return;
    }

    let ridersHostile = false;
    if (Math.random() * 10 < 3) {
      this.log("Riders ahead. They don't look hostile.");
      ridersHostile = false;
    } else {
      this.log("Riders ahead. They look hostile.");
      ridersHostile = true;
    }

    let myTactic = 0;
    while (true) {
      myTactic = await this.prompt("\nTactics\n(1) Run (2) Attack (3) Continue (4) Circle Wagons: ", 'number');
      if (myTactic !== null && myTactic > 0 && myTactic < 5) {
        break;
      }
      this.log("Sorry, I didn't understand that.");
    }

    if (ridersHostile) {
      if (myTactic === 1) {
        this.gameVariables.mileage += 20;
        this.gameVariables.ammunition -= 150;
        this.gameVariables.animals -= 40;
      } else if (myTactic === 2) {
        const myShoot = await this.shooting();
        this.gameVariables.ammunition -= (myShoot * 40) + 80;
        if (myShoot === 1) {
          this.log("Nice Shooting Tex - You drove them off.");
        } else if (myShoot > 4) {
          this.log("Lousy Shot - You got knifed\nYou have to see Ol' Doc Blanchard.");
          this.gameVariables.injury = true;
        } else {
          this.log("Kinda slow with your Colt .45");
        }
      } else if (myTactic === 3) {
        if (Math.random() * 10 > 7) {
          this.log("They did not attack.");
          ridersHostile = false;
        } else {
          this.gameVariables.ammunition -= 150;
          this.gameVariables.mileage -= 15;
        }
      } else {
        const myShoot = await this.shooting();
        this.gameVariables.ammunition -= (myShoot * 30) + 80;
        this.gameVariables.mileage -= 25;
        if (myShoot === 1) {
          this.log("Nice Shooting Tex - You drove them off.");
        } else if (myShoot > 4) {
          this.log("Lousy Shot - You got knifed\nYou have to see Ol' Doc Blanchard.");
          this.gameVariables.injury = true;
        } else {
          this.log("Kinda slow with your Colt .45");
        }
      }
    } else {
      if (myTactic === 1) {
        this.gameVariables.mileage += 15;
        this.gameVariables.animals -= 10;
      } else if (myTactic === 2) {
        this.gameVariables.mileage -= 5;
        this.gameVariables.ammunition -= 100;
      } else if (myTactic === 3) {
        this.gameVariables.mileage -= 5;
        this.log("They did not attack.");
      } else {
        this.gameVariables.mileage -= 5;
        this.log("They did not attack.");
      }
    }

    if (ridersHostile) {
      this.log("The Riders were hostile - Check for loses.");
      if (this.gameVariables.ammunition < 1) {
        this.log("You ran out of bullets and got massacred by the riders!");
        this.dying("injury");
      }
    } else {
      this.log("The Riders were friendly, but check for possible losses.");
    }

    this.updateState();
  }

  async runTrail() {
    const gameWeekDates = [
      "March 29", "April 12", "April 26", "May 10", "May 24", "June 7", "June 21",
      "July 5", "July 19", "August 2", "August 16", "August 31", "September 13",
      "September 27", "October 11", "October 25", "November 8", "November 22",
      "December 6", "December 20"
    ];

    while (true) {
      this.gameVariables.game_turn += 1;

      if (this.gameVariables.game_turn < 19) {
        if (this.gameVariables.mileage > 2040) {
          this.finalTurn();
          break;
        }

        this.log(`\nMonday, ${gameWeekDates[this.gameVariables.game_turn]}, 1847`);

        const continueGame = await this.gameLoop();
        if (!continueGame) break;

        this.doEvents();
        await this.riders();

        if (this.gameVariables.mileage > 950) {
          this.mountains();
        }
      } else {
        this.log("\nYou have been on the trail too long\nYour family dies in the first blizzard of winter.");
        this.dying("");
        break;
      }
    }
  }

  async start() {
    this.log("This program simulates a trip over the oregon trail from Independence,");
    this.log("Missouri to Oregon City, Oregon in 1847 your family of five will cover");
    this.log("the 2040 mile Oregon Trail in 5-6 months --- if you make it alive.\n");

    const needsInstructions = await this.prompt("Do you need instructions (yes/no): ", 'text');
    if (needsInstructions.toLowerCase() === 'yes') {
      this.showInstructions();
    }

    this.log("\nHow good a shot are you with your rifle?");
    this.log("\t(1) ace marksman,  (2) good shot,  (3) fair to middlin'");
    this.log("\t(4) need more practice,  (5) shaky knees");

    let shootingLevel = await this.prompt(
      "Enter one of the above -- the better you claim you are, the\n" +
      "faster you'll have to be with your gun to be successful: ",
      'number'
    );

    if (shootingLevel === null || shootingLevel > 5 || shootingLevel < 1) {
      shootingLevel = 0;
    }
    this.gameVariables.shooting_expert_level = shootingLevel;

    await this.initialPurchases();

    this.gameVariables.game_turn = -1;
    await this.runTrail();
  }

  async resume() {
    this.log("\nResuming your journey...\n");
    this.updateState();
    await this.runTrail();
  }
}

// Export for Node.js and browsers
if (typeof module !== 'undefined' && module.exports) {
  module.exports = OregonTrailGame;
}
